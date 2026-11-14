import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, type ServerExtension } from '@chokh/server';
import { signHs256 } from '@chokh/server/jwt';
import { ssoClaimsFor } from '@chokh/server/sso';
import { createMemoryStore } from '@chokh/server/store/memory';
import { defaultSiteSettings } from '@chokh/server/store';
import type { AuditEntry } from '@chokh/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildExtension } from '../extension.js';
import { ALL_FEATURES, type LicensePayload } from '../license/payload.js';
import { publicKeyToBase64, signLicense } from '../license/token.js';
import { OIDC_ATTEMPTS } from './oidc.routes.js';
import { startProvider, type Lie, type TestProvider } from './provider.test-utils.js';

// Signing in through an identity provider, over HTTP against the real server
// and a provider that lives inside this file. What each case is about is
// whether the server believes something it should not: a token, a callback,
// an address.

const SITE_ID = 's_test';
const TEAM_ID = 'default';
const PASSWORD = 'a-password-long-enough';
const OWNER_EMAIL = 'owner@test.example';
const PUBLIC_URL = 'https://chokh.test';
const FLOW = 'chokh_oidc';
const SESSION = 'chokh_session';
const MINUTE = 60_000;

interface Answer {
  status: number;
  code: string | undefined;
  data: Record<string, unknown>;
  location: string | undefined;
  cookies: Record<string, { value: string; path?: string; httpOnly?: boolean; sameSite?: string; maxAge?: number }>;
  body: string;
}

interface Install {
  app: FastifyInstance;
  store: ReturnType<typeof createMemoryStore>;
  provider: TestProvider;
  owner: { cookie: string; userId: string };
  log: string[];
  minutes(count: number): void;
  ask(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    options?: { cookie?: string; headers?: Record<string, string>; payload?: object | string },
  ): Promise<Answer>;
  // Leave for the provider: the address the browser is sent to, and the
  // flow cookie it leaves with.
  depart(from?: Promise<Answer>): Promise<{ url: string; flow: string }>;
  // Come back from the provider with whatever it sent, carrying the cookies
  // given.
  arrive(url: string, cookies: string, html?: boolean): Promise<Answer>;
  rows(action: string): Promise<AuditEntry[]>;
  close(): Promise<void>;
}

async function install(
  options: {
    licensed?: boolean;
    configured?: boolean;
    // The issuer as this install was told it, when that is not the provider's.
    issuer?: (provider: TestProvider) => string;
    // A provider whose own name ends in a slash.
    slash?: boolean;
  } = {},
): Promise<Install> {
  let at = Date.now();
  const now = (): number => at;
  const provider = await startProvider({ now, ...(options.slash === true ? { slash: true } : {}) });

  let extension: ServerExtension;
  const oidc =
    options.configured === false
      ? null
      : {
          issuer: options.issuer?.(provider) ?? provider.issuer,
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
          publicUrl: PUBLIC_URL,
        };
  if (options.licensed === false) {
    extension = buildExtension({ raw: undefined, publicKeys: [] }, { oidc });
  } else {
    const generated = generateKeyPairSync('ed25519');
    const issuedAt = Math.floor(Date.now() / 1000);
    const license: LicensePayload = {
      v: 1,
      id: 'lic_oidc',
      licensee: 'A Test Company Ltd.',
      plan: 'pro',
      features: [ALL_FEATURES],
      seats: null,
      sites: null,
      issuedAt,
      expiresAt: issuedAt + 365 * 86_400,
    };
    extension = buildExtension(
      {
        raw: signLicense(generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), license),
        publicKeys: [
          publicKeyToBase64(generated.publicKey.export({ format: 'pem', type: 'spki' }).toString()),
        ],
      },
      { oidc },
    );
  }

  const store = createMemoryStore();
  const log: string[] = [];
  const app = await buildApp({
    store,
    extensions: [extension],
    now,
    log: { level: 'trace', stream: { write: (line: string) => void log.push(line) } },
  });
  await app.ready();

  const ask: Install['ask'] = async (method, url, given = {}) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(given.cookie === undefined ? {} : { cookie: given.cookie }),
        ...(given.headers ?? {}),
      },
      ...(given.payload === undefined ? {} : { payload: given.payload }),
    });
    let parsed: { data?: Record<string, unknown>; error?: { code?: string } } = {};
    try {
      parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
      // A redirect has no body to read.
    }
    const cookies: Answer['cookies'] = {};
    for (const cookie of response.cookies) {
      cookies[cookie.name] = {
        value: cookie.value,
        ...(typeof cookie.path === 'string' ? { path: cookie.path } : {}),
        ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
        ...(cookie.sameSite === undefined ? {} : { sameSite: String(cookie.sameSite) }),
        ...(cookie.maxAge === undefined ? {} : { maxAge: cookie.maxAge }),
      };
    }
    const location = response.headers.location;
    return {
      status: response.statusCode,
      code: parsed.error?.code,
      data: parsed.data ?? {},
      location: typeof location === 'string' ? location : undefined,
      cookies,
      body: response.body,
    };
  };

  const first = await ask('POST', '/api/auth/register', {
    payload: { email: OWNER_EMAIL, password: PASSWORD },
  });
  const owner = {
    cookie: `${SESSION}=${first.cookies[SESSION]?.value ?? ''}`,
    userId: (first.data['user'] as { id: string }).id,
  };
  await store.createSite({
    id: SITE_ID,
    name: 'Test site',
    domains: ['test.example'],
    teamId: TEAM_ID,
    settings: defaultSiteSettings({ timezone: 'UTC' }),
  });

  return {
    app,
    store,
    provider,
    owner,
    log,
    minutes(count) {
      at += count * MINUTE;
    },
    ask,
    async depart(from) {
      // Signing in is limited by address, and every case here is one address.
      at += MINUTE + 1000;
      const started = await (from ?? ask('GET', '/api/ee/oidc/start'));
      const url = started.location ?? (started.data['url'] as string | undefined);
      const flow = started.cookies[FLOW]?.value;
      if (url === undefined || flow === undefined) {
        throw new Error(`the flow did not begin: ${started.status} ${started.code}`);
      }
      return { url, flow: `${FLOW}=${flow}` };
    },
    arrive(url, cookies, html = false) {
      at += MINUTE + 1000;
      const back = new URL(provider.authorize(url));
      return ask('GET', `${back.pathname}${back.search}`, {
        cookie: cookies,
        ...(html ? { headers: { accept: 'text/html' } } : {}),
      });
    },
    async rows(action) {
      return (await store.auditPage({ scope: { kind: 'team', id: TEAM_ID }, limit: 200 })).rows.filter(
        (row) => row.action === action,
      );
    },
    async close() {
      await app.close();
      await provider.close();
    },
  };
}

let here: Install;

afterEach(async () => {
  vi.useRealTimers();
  await here.close();
});

// The owner connects their account, which is how an account comes to be
// signed in by an identity at all.
async function connect(who: { cookie: string } = here.owner): Promise<void> {
  const leaving = await here.depart(here.ask('POST', '/api/ee/oidc/link', { cookie: who.cookie, payload: {} }));
  const back = await here.arrive(leaving.url, `${leaving.flow}; ${who.cookie}`);
  if (back.status !== 303) {
    throw new Error(`connecting answered ${back.status} ${back.code}`);
  }
}

async function signIn(html = false): Promise<Answer> {
  const leaving = await here.depart();
  return here.arrive(leaving.url, leaving.flow, html);
}

describe('switched on only by configuration and a licence, both', () => {
  it('is off with a key and no configuration', async () => {
    here = await install({ configured: false });
    expect((await here.ask('GET', '/api/ee/oidc')).data).toEqual({ enabled: false });
    const start = await here.ask('GET', '/api/ee/oidc/start');
    expect([start.status, start.code]).toEqual([404, 'OIDC_OFF']);
    // A browser is sent to the sign-in page and not shown an error object.
    here.minutes(2);
    const page = await here.ask('GET', '/api/ee/oidc/start', { headers: { accept: 'text/html' } });
    expect([page.status, page.location]).toEqual([303, '/login?sso=OIDC_OFF']);
    const link = await here.ask('POST', '/api/ee/oidc/link', { cookie: here.owner.cookie, payload: {} });
    expect([link.status, link.code]).toEqual([404, 'OIDC_OFF']);
  });

  it('is off with configuration and no key, and the password still signs in', async () => {
    here = await install({ licensed: false });
    expect((await here.ask('GET', '/api/ee/oidc')).data).toEqual({ enabled: false });
    expect((await here.ask('GET', '/api/ee/oidc/start')).code).toBe('OIDC_OFF');
    here.minutes(2);
    expect((await here.ask('GET', '/api/ee/oidc/callback?code=x&state=y')).code).toBe('OIDC_OFF');
    const link = await here.ask('POST', '/api/ee/oidc/link', { cookie: here.owner.cookie, payload: {} });
    expect([link.status, link.code]).toEqual([403, 'LICENSE_REQUIRED']);
    // Nothing was asked of the provider by an install that may not use it.
    expect(here.provider.calls).toEqual({ discovery: 0, keys: 0, token: 0 });
    here.minutes(2);
    const password = await here.ask('POST', '/api/auth/login', {
      payload: { email: OWNER_EMAIL, password: PASSWORD },
    });
    expect(password.status).toBe(200);
  });

  it('is on with both, and says so to whoever asks without saying anything else', async () => {
    here = await install();
    const status = await here.ask('GET', '/api/ee/oidc');
    expect(status.data).toEqual({ enabled: true });
    expect(status.body).not.toContain(here.provider.issuer);
  });
});

describe('leaving for the provider', () => {
  it('sends the browser with a state, a nonce and a challenge, and never the secret', async () => {
    here = await install();
    const start = await here.ask('GET', '/api/ee/oidc/start');
    expect(start.status).toBe(302);
    const url = new URL(start.location ?? '');
    expect(url.origin).toBe(here.provider.issuer);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: here.provider.clientId,
      // Built from configuration, never from the request.
      redirect_uri: `${PUBLIC_URL}/api/ee/oidc/callback`,
      scope: 'openid profile email',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
    });
    expect(start.location).not.toContain(here.provider.clientSecret);
  });

  it('builds where the provider sends the browser back from configuration, whatever the request says of itself', async () => {
    here = await install();
    const start = await here.ask('GET', '/api/ee/oidc/start', {
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        origin: 'https://evil.example',
      },
    });
    expect(new URL(start.location ?? '').searchParams.get('redirect_uri')).toBe(
      `${PUBLIC_URL}/api/ee/oidc/callback`,
    );
    expect(start.location).not.toContain('evil.example');
  });

  it('leaves a cookie the browser can neither read nor send anywhere but the callback', async () => {
    here = await install();
    const start = await here.ask('GET', '/api/ee/oidc/start');
    const url = new URL(start.location ?? '');
    const cookie = start.cookies[FLOW];
    expect(cookie).toMatchObject({
      path: '/api/ee/oidc/callback',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 600,
    });
    // Sealed: nothing the flow depends on can be read out of it.
    const carried = Buffer.from(cookie?.value ?? '', 'base64url').toString('latin1');
    for (const secret of [url.searchParams.get('state'), url.searchParams.get('nonce')]) {
      expect(cookie?.value).not.toContain(secret ?? '');
      expect(carried).not.toContain(secret ?? '');
    }
  });
});

describe('who somebody is', () => {
  it('is nobody when no account is connected to that identity: nothing is found by address, and nothing is made', async () => {
    here = await install();
    // The provider says this person has the owner's own address, verified.
    here.provider.email = OWNER_EMAIL;
    const before = await here.store.userCount();
    const back = await signIn();
    expect([back.status, back.code]).toEqual([403, 'OIDC_UNKNOWN_IDENTITY']);
    expect(back.cookies[SESSION]).toBeUndefined();
    expect(await here.store.userCount()).toBe(before);
    expect(await here.store.identitiesForUser(here.owner.userId)).toEqual([]);
    // In a browser: the sign-in page, with the reason.
    const page = await signIn(true);
    expect([page.status, page.location]).toEqual([303, '/login?sso=OIDC_UNKNOWN_IDENTITY']);
  });

  it('is the account that connected itself, signed in by the ordinary session', async () => {
    here = await install();
    await connect();
    expect(await here.store.identitiesForUser(here.owner.userId)).toEqual([
      {
        issuer: here.provider.issuer,
        subject: 'provider-user-1',
        userId: here.owner.userId,
        linkedAt: expect.any(Number),
      },
    ]);
    // Recorded, with which provider and never who there.
    const [row] = await here.rows('identity:link');
    expect(row).toMatchObject({
      actor: { kind: 'session', id: here.owner.userId, email: OWNER_EMAIL },
      target: here.owner.userId,
      fields: [`issuer: ${here.provider.issuer}`],
      route: 'GET /api/ee/oidc/callback',
    });
    expect(JSON.stringify(row)).not.toContain('provider-user-1');

    const back = await signIn();
    expect([back.status, back.location]).toEqual([303, '/']);
    const session = back.cookies[SESSION];
    expect(session).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Lax' });
    const me = await here.ask('GET', '/api/me', { cookie: `${SESSION}=${session?.value ?? ''}` });
    expect((me.data['user'] as { id: string }).id).toBe(here.owner.userId);
    // The flow cookie is taken away on the way back.
    expect(back.cookies[FLOW]?.value).toBe('');
    // The code was exchanged with the verifier, and the secret went to the
    // provider in a header and nowhere else.
    const exchanged = here.provider.tokenRequests.at(-1);
    expect(exchanged?.form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchanged?.form.get('client_secret')).toBeNull();
    expect(exchanged?.authorization).toMatch(/^Basic /);
  });

  it('goes back to where the person was going, and only ever inside this dashboard', async () => {
    here = await install();
    await connect();
    const inside = await here.depart(here.ask('GET', '/api/ee/oidc/start?next=%2Fs_test%2Fsources'));
    expect((await here.arrive(inside.url, inside.flow)).location).toBe('/s_test/sources');
    for (const outside of [
      'https://evil.example/',
      '//evil.example/',
      'javascript:alert(1)',
      // Each of these begins with one slash and not two, and a browser reads
      // each as //evil.example: it takes a backslash for a slash, and drops a
      // tab, a carriage return and a line feed before it reads anything.
      '/\\evil.example',
      '/\t/evil.example',
      '/\r/evil.example',
      '/\n/evil.example',
    ]) {
      // Where a browser would go, were it sent there from the callback.
      if (outside.startsWith('/') && !outside.startsWith('//')) {
        expect(new URL(outside, 'https://chokh.test/api/ee/oidc/callback').origin).toBe(
          'https://evil.example',
        );
      }
      const leaving = await here.depart(
        here.ask('GET', `/api/ee/oidc/start?next=${encodeURIComponent(outside)}`),
      );
      expect((await here.arrive(leaving.url, leaving.flow)).location).toBe('/');
    }
  });

  it('is somebody else at the same provider when the subject is somebody else', async () => {
    here = await install();
    await connect();
    here.provider.subject = 'provider-user-2';
    here.provider.email = OWNER_EMAIL;
    expect((await signIn()).code).toBe('OIDC_UNKNOWN_IDENTITY');
  });
});

// What ties a return to a departure is the cookie of the flow this browser
// began. The callback is a GET that ends in a session, so this, and not a
// header, is its protection.
describe('a callback', () => {
  it('that arrives in a browser that did not begin a flow is refused before the provider is asked anything', async () => {
    here = await install();
    await connect();
    const asked = here.provider.calls.token;
    const leaving = await here.depart();
    // The victim's browser: the attacker's code and state, and no flow cookie.
    const back = await here.arrive(leaving.url, '');
    expect([back.status, back.code]).toEqual([400, 'OIDC_STATE']);
    expect(back.cookies[SESSION]).toBeUndefined();
    expect(here.provider.calls.token).toBe(asked);
    // The same with a session of its own: it is not linked to anything.
    const second = await here.depart();
    const signedIn = await here.arrive(second.url, here.owner.cookie);
    expect(signedIn.code).toBe('OIDC_STATE');
  });

  it('whose state is another flow is refused', async () => {
    here = await install();
    await connect();
    const mine = await here.depart();
    const theirs = await here.depart();
    // Their code and state, my cookie.
    const back = await here.arrive(theirs.url, mine.flow);
    expect(back.code).toBe('OIDC_STATE');
    expect(back.cookies[SESSION]).toBeUndefined();
  });

  it('used once is spent: replayed with its own cookie, it signs in nobody', async () => {
    here = await install();
    await connect();
    const leaving = await here.depart();
    const back = new URL(here.provider.authorize(leaving.url));
    const path = `${back.pathname}${back.search}`;
    here.minutes(2);
    expect((await here.ask('GET', path, { cookie: leaving.flow })).status).toBe(303);
    here.minutes(2);
    const again = await here.ask('GET', path, { cookie: leaving.flow });
    expect([again.status, again.code]).toEqual([400, 'OIDC_REPLAYED']);
    expect(again.cookies[SESSION]).toBeUndefined();
  });

  it('that comes back after ten minutes finds no flow', async () => {
    here = await install();
    await connect();
    const leaving = await here.depart();
    here.minutes(10);
    expect((await here.arrive(leaving.url, leaving.flow)).code).toBe('OIDC_STATE');
  });

  it('that carries the provider saying no signs in nobody', async () => {
    here = await install();
    const leaving = await here.depart();
    const state = new URL(leaving.url).searchParams.get('state') ?? '';
    here.minutes(2);
    const back = await here.ask('GET', `/api/ee/oidc/callback?error=access_denied&state=${state}`, {
      cookie: leaving.flow,
    });
    expect([back.status, back.code]).toEqual([400, 'OIDC_DENIED']);
  });
});

describe('an ID token', () => {
  const LIES: [Lie, string][] = [
    ['issuer', 'that names another issuer'],
    ['audience', 'made for another client'],
    ['party', 'whose authorized party is another client'],
    ['nonce', 'that answers another sign-in'],
    ['expired', 'that has expired'],
    ['future', 'issued an hour from now'],
    ['unsigned', 'that says alg none and carries no signature'],
    ['hmac', 'signed HS256 with the public key as the secret'],
    ['wrong-key', 'signed by a key nobody published, under a published key id'],
    ['unknown-key', 'signed by a key under an id nobody published'],
    ['no-subject', 'that names nobody'],
  ];

  it.each(LIES)('%s: one %s is not believed, and signs in nobody', async (lie) => {
    here = await install();
    await connect();
    here.provider.lie = lie;
    const back = await signIn();
    expect([back.status, back.code]).toEqual([401, 'OIDC_TOKEN']);
    expect(back.cookies[SESSION]).toBeUndefined();
    // The honest one, straight after, is believed: the refusal was the lie.
    here.provider.lie = null;
    expect((await signIn()).status).toBe(303);
  });

  it('is not asked for at all when the provider refuses the code', async () => {
    here = await install();
    await connect();
    const leaving = await here.depart();
    // The code is used up at the provider before this server presents it.
    const back = new URL(here.provider.authorize(leaving.url));
    await fetch(`${here.provider.issuer}/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${here.provider.clientId}:${here.provider.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code') ?? '' }),
    });
    here.minutes(2);
    const answer = await here.ask('GET', `${back.pathname}${back.search}`, { cookie: leaving.flow });
    expect([answer.status, answer.code]).toEqual([401, 'OIDC_EXCHANGE']);
  });
});

describe('the keys of the provider', () => {
  it('are read again when it rotates them, and not more than once in thirty seconds for a key id nobody has seen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    here = await install();
    await connect();
    expect((await signIn()).status).toBe(303);
    const read = here.provider.calls.keys;

    // A made-up key id, three times in a row: the set is not fetched again
    // inside the thirty seconds since it was last read.
    here.provider.lie = 'unknown-key';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await signIn()).code).toBe('OIDC_TOKEN');
    }
    expect(here.provider.calls.keys).toBe(read);
    here.provider.lie = null;

    // The provider rotates. Past the thirty seconds, the new key works on the
    // next sign-in, with one more read of the set.
    await here.provider.rotate();
    vi.setSystemTime(Date.now() + 31_000);
    expect((await signIn()).status).toBe(303);
    expect(here.provider.calls.keys).toBe(read + 1);
  });
});

describe('a provider that is not what it was configured as', () => {
  it('is not used when its own discovery names another issuer', async () => {
    here = await install();
    here.provider.discoveryIssuer = 'https://somebody-else.example';
    const start = await here.ask('GET', '/api/ee/oidc/start');
    expect([start.status, start.code]).toEqual([502, 'OIDC_UNAVAILABLE']);
    expect(start.cookies[FLOW]).toBeUndefined();
  });

  it('is not asked anything over plain http unless it is on this machine', async () => {
    here = await install({ issuer: () => 'http://provider.example' });
    const start = await here.ask('GET', '/api/ee/oidc/start');
    expect([start.status, start.code]).toEqual([502, 'OIDC_UNAVAILABLE']);
    expect(here.provider.calls.discovery).toBe(0);
  });
});

describe('connecting an account', () => {
  it('is bound to the session that began it: no session on the return, or another one, connects nothing', async () => {
    here = await install();
    const added = await here.ask('POST', '/api/auth/register', {
      cookie: here.owner.cookie,
      payload: { email: 'second@test.example', password: PASSWORD },
    });
    const secondId = (added.data['user'] as { id: string }).id;
    await here.store.setTeamMember(TEAM_ID, { userId: secondId, role: 'viewer', identity: false });
    here.minutes(2);
    const signedIn = await here.ask('POST', '/api/auth/login', {
      payload: { email: 'second@test.example', password: PASSWORD },
    });
    const second = `${SESSION}=${signedIn.cookies[SESSION]?.value ?? ''}`;

    // Began by the owner, returned with no session at all.
    const first = await here.depart(here.ask('POST', '/api/ee/oidc/link', { cookie: here.owner.cookie, payload: {} }));
    const nobody = await here.arrive(first.url, first.flow);
    expect([nobody.status, nobody.code]).toEqual([401, 'OIDC_SESSION_CHANGED']);
    // Began by the owner, returned as somebody else.
    const other = await here.depart(here.ask('POST', '/api/ee/oidc/link', { cookie: here.owner.cookie, payload: {} }));
    const swapped = await here.arrive(other.url, `${other.flow}; ${second}`);
    expect(swapped.code).toBe('OIDC_SESSION_CHANGED');
    expect(await here.store.identitiesForUser(here.owner.userId)).toEqual([]);
    expect(await here.store.identitiesForUser(secondId)).toEqual([]);

    // An identity one account signs in by is not also another's.
    await connect();
    const taken = await here.depart(here.ask('POST', '/api/ee/oidc/link', { cookie: second, payload: {} }));
    const refused = await here.arrive(taken.url, `${taken.flow}; ${second}`);
    expect([refused.status, refused.code]).toEqual([409, 'IDENTITY_TAKEN']);
    expect(await here.store.identitiesForUser(secondId)).toEqual([]);
  });

  it('is begun from this dashboard and by a person: not as a form, not from another site, not by a key', async () => {
    here = await install();
    const form = await here.ask('POST', '/api/ee/oidc/link', {
      cookie: here.owner.cookie,
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect([form.status, form.code]).toEqual([415, 'JSON_REQUIRED']);
    const elsewhere = await here.ask('POST', '/api/ee/oidc/link', {
      cookie: here.owner.cookie,
      headers: { 'sec-fetch-site': 'cross-site' },
      payload: {},
    });
    expect([elsewhere.status, elsewhere.code]).toEqual([403, 'CROSS_SITE_REQUEST']);
    expect((await here.ask('POST', '/api/ee/oidc/link', { payload: {} })).status).toBe(401);
    expect(form.cookies[FLOW]).toBeUndefined();
    expect(elsewhere.cookies[FLOW]).toBeUndefined();
  });

  it('can be undone by an account that has a password, and is recorded', async () => {
    here = await install();
    await connect();
    const status = await here.ask('GET', '/api/ee/oidc/identity', { cookie: here.owner.cookie });
    expect(status.data).toEqual({ enabled: true, connected: true, canDisconnect: true });
    const gone = await here.ask('DELETE', '/api/ee/oidc/identity', { cookie: here.owner.cookie });
    expect([gone.status, gone.data]).toEqual([200, { connected: false }]);
    expect(await here.store.identitiesForUser(here.owner.userId)).toEqual([]);
    expect(await here.rows('identity:unlink')).toHaveLength(1);
    expect((await signIn()).code).toBe('OIDC_UNKNOWN_IDENTITY');
    const again = await here.ask('DELETE', '/api/ee/oidc/identity', { cookie: here.owner.cookie });
    expect([again.status, again.code]).toEqual([404, 'NOT_CONNECTED']);
  });
});

describe('an invitation used by signing in at the provider', () => {
  async function invite(email: string): Promise<{ id: string; token: string }> {
    const sent = await here.ask('POST', `/api/teams/${TEAM_ID}/invitations`, {
      cookie: here.owner.cookie,
      payload: { email, role: 'editor', identity: false },
    });
    return {
      id: (sent.data['invitation'] as { id: string }).id,
      token: (sent.data['once'] as { token: string }).token,
    };
  }

  const use = (token: string, headers: Record<string, string> = {}) =>
    here.ask('POST', '/api/ee/oidc/invite', { headers, payload: { token } });

  it('makes the account the invitation is for, with its address and no password, and lets them in', async () => {
    here = await install();
    const sent = await invite('ada@test.example');
    // What the provider calls them is not what the account is called.
    here.provider.subject = 'provider-ada';
    here.provider.email = 'somebody-else@provider.example';
    here.provider.name = 'Ada Lovelace';

    const leaving = await here.depart(use(sent.token));
    // The token went in sealed: it cannot be read out of the cookie.
    expect(Buffer.from(leaving.flow.split('=')[1] ?? '', 'base64url').toString('latin1')).not.toContain(
      sent.token,
    );
    const back = await here.arrive(leaving.url, leaving.flow);
    expect([back.status, back.location]).toEqual([303, '/']);

    const ada = await here.store.userByEmail('ada@test.example');
    expect(ada).toMatchObject({ email: 'ada@test.example', name: 'Ada Lovelace' });
    expect(ada?.passwordHash).toBeUndefined();
    expect(await here.store.userByEmail('somebody-else@provider.example')).toBeNull();
    expect(await here.store.userByIdentity(here.provider.issuer, 'provider-ada')).toMatchObject({
      id: ada?.id,
    });
    expect((await here.store.team(TEAM_ID))?.members).toContainEqual({
      userId: ada?.id,
      role: 'editor',
      identity: false,
    });
    // Signed in by the answer, and again by the provider afterwards.
    const me = await here.ask('GET', '/api/me', { cookie: `${SESSION}=${back.cookies[SESSION]?.value ?? ''}` });
    expect((me.data['user'] as { email: string }).email).toBe('ada@test.example');
    expect((await signIn()).status).toBe(303);
    // Spent, and in the log: the invitation used, and the identity connected.
    expect((await here.store.invitation(sent.id))?.acceptedAt).toEqual(expect.any(Number));
    expect(await here.rows('invite:accept')).toHaveLength(1);
    expect((await here.rows('identity:link'))[0]).toMatchObject({ target: ada?.id });

    // With no password it is their only way in, and it stays.
    const session = `${SESSION}=${back.cookies[SESSION]?.value ?? ''}`;
    const status = await here.ask('GET', '/api/ee/oidc/identity', { cookie: session });
    expect(status.data).toEqual({ enabled: true, connected: true, canDisconnect: false });
    const refused = await here.ask('DELETE', '/api/ee/oidc/identity', { cookie: session });
    expect([refused.status, refused.code]).toEqual([409, 'ONLY_WAY_IN']);
    expect(await here.store.identitiesForUser(ada?.id ?? '')).toHaveLength(1);
  });

  it('is not a way into an account that already has the address: that account signs in and connects itself', async () => {
    here = await install();
    await here.ask('POST', '/api/auth/register', {
      cookie: here.owner.cookie,
      payload: { email: 'grace@test.example', password: PASSWORD },
    });
    const sent = await invite('grace@test.example');
    here.provider.subject = 'provider-grace';
    here.provider.email = 'grace@test.example';
    const leaving = await here.depart(use(sent.token));
    const back = await here.arrive(leaving.url, leaving.flow);
    expect([back.status, back.code]).toEqual([401, 'SIGN_IN_REQUIRED']);
    expect(back.cookies[SESSION]).toBeUndefined();
    const grace = await here.store.userByEmail('grace@test.example');
    expect(await here.store.identitiesForUser(grace?.id ?? '')).toEqual([]);
    expect((await here.store.invitation(sent.id))?.acceptedAt).toBeUndefined();
  });

  it('is accepted by its own address only, also for somebody the provider already vouches for', async () => {
    here = await install();
    await connect();
    const sent = await invite('ada@test.example');
    // The owner, connected, arrives with an invitation that is Ada's.
    const leaving = await here.depart(use(sent.token));
    const back = await here.arrive(leaving.url, leaving.flow);
    expect([back.status, back.code]).toEqual([403, 'INVITATION_ADDRESS_MISMATCH']);
    expect(await here.store.userByEmail('ada@test.example')).toBeNull();
    expect((await here.store.invitation(sent.id))?.acceptedAt).toBeUndefined();
  });

  it('is refused before the browser goes anywhere when the link would be, and is begun from this dashboard', async () => {
    here = await install();
    const sent = await invite('ada@test.example');
    const unknown = await use('chi_a-token-nothing-answers-to-000000000000');
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.cookies[FLOW]).toBeUndefined();

    const form = await here.ask('POST', '/api/ee/oidc/invite', {
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ token: sent.token }),
    });
    expect([form.status, form.code]).toEqual([415, 'JSON_REQUIRED']);
    const elsewhere = await use(sent.token, { 'sec-fetch-site': 'same-site' });
    expect([elsewhere.status, elsewhere.code]).toEqual([403, 'CROSS_SITE_REQUEST']);
    expect(elsewhere.cookies[FLOW]).toBeUndefined();
  });
});

describe('what never leaves', () => {
  it('the client secret is in no answer, no redirect and no log line, and neither is a code verifier', async () => {
    here = await install();
    await connect();
    const leaving = await here.depart();
    const back = await here.arrive(leaving.url, leaving.flow);
    expect(back.status).toBe(303);
    const verifier = here.provider.tokenRequests.at(-1)?.form.get('code_verifier') ?? 'missing';
    // The log did see these requests: an empty log would prove nothing.
    const written = here.log.join('\n');
    expect(written).toContain('/api/ee/oidc/callback');
    for (const secret of [here.provider.clientSecret, verifier]) {
      expect(written).not.toContain(secret);
      expect(leaving.url).not.toContain(secret);
      expect(back.body).not.toContain(secret);
    }
    // Nothing kept afterwards holds a token from the provider.
    expect(JSON.stringify(await here.store.identitiesForUser(here.owner.userId))).not.toContain('eyJ');
  });

  // The line the framework writes for a request carries its address, query
  // and all. On these two routes the query holds what the provider sent back
  // and where somebody was going, so they are logged by their path alone.
  it('the code, the state and where somebody was going are in no log line', async () => {
    here = await install();
    await connect();
    const leaving = await here.depart(here.ask('GET', '/api/ee/oidc/start?next=%2Fs_test%2Fsources'));
    const back = new URL(here.provider.authorize(leaving.url));
    const code = back.searchParams.get('code') ?? 'missing';
    const state = back.searchParams.get('state') ?? 'missing';
    here.minutes(2);
    const arrived = await here.ask('GET', `${back.pathname}${back.search}`, { cookie: leaving.flow });
    expect([arrived.status, arrived.location]).toEqual([303, '/s_test/sources']);

    const lines = here.log.filter((line) => line.includes('/api/ee/oidc/'));
    // Both requests were logged, as their paths.
    expect(lines.some((line) => line.includes('"url":"/api/ee/oidc/start"'))).toBe(true);
    expect(lines.some((line) => line.includes('"url":"/api/ee/oidc/callback"'))).toBe(true);
    const written = here.log.join('\n');
    for (const kept of [code, state, 's_test%2Fsources', 'next=', 'code=', 'state=']) {
      expect(written).not.toContain(kept);
    }
  });
});

// An issuer is a name, compared character for character. Auth0's ends in a
// slash, in its discovery document and in every token.
describe('an issuer that ends in a slash', () => {
  it('signs somebody in when it is configured exactly as the provider states it', async () => {
    here = await install({ slash: true });
    expect(here.provider.issuer.endsWith('/')).toBe(true);
    await connect();
    expect((await signIn()).status).toBe(303);
    expect((await here.store.identitiesForUser(here.owner.userId))[0]?.issuer).toBe(here.provider.issuer);
  });

  it('is not the same issuer without its slash, nor with one it does not have: exact is the rule', async () => {
    here = await install({ slash: true, issuer: (provider) => provider.issuer.replace(/\/$/, '') });
    const without = await here.ask('GET', '/api/ee/oidc/start');
    expect([without.status, without.code]).toEqual([502, 'OIDC_UNAVAILABLE']);
    expect(without.cookies[FLOW]).toBeUndefined();
    await here.close();

    here = await install({ issuer: (provider) => `${provider.issuer}/` });
    const added = await here.ask('GET', '/api/ee/oidc/start');
    expect([added.status, added.code]).toEqual([502, 'OIDC_UNAVAILABLE']);
    // The configuration was found, by its address without the slash, and was
    // not believed: it names another issuer.
    expect(here.provider.calls.discovery).toBe(1);
  });
});

// A start is a GET, and any page can make a browser send one. It must not be
// a way to use up the attempts an address has left to sign in with a
// password, and it must not be a way to use up this feature's own.
describe('how often', () => {
  const login = () =>
    here.ask('POST', '/api/auth/login', { payload: { email: OWNER_EMAIL, password: PASSWORD } });

  it('a start another site began begins nothing, sets nothing and counts nothing', async () => {
    here = await install();
    here.minutes(2);
    for (const site of ['cross-site', 'same-site']) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const program = await here.ask('GET', '/api/ee/oidc/start', { headers: { 'sec-fetch-site': site } });
        expect([program.status, program.code]).toEqual([403, 'CROSS_SITE_REQUEST']);
        expect(program.cookies[FLOW]).toBeUndefined();
      }
    }
    // A browser is sent to the sign-in page, where the button is.
    const browser = await here.ask('GET', '/api/ee/oidc/start', {
      headers: { 'sec-fetch-site': 'cross-site', accept: 'text/html' },
    });
    expect([browser.status, browser.location]).toEqual([303, '/login']);
    expect(browser.cookies[FLOW]).toBeUndefined();
    // And ten returns this browser never began.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await here.ask('GET', '/api/ee/oidc/callback?code=x&state=y')).code).toBe('OIDC_STATE');
    }
    // Nothing was asked of the provider on account of any of it.
    expect(here.provider.calls).toEqual({ discovery: 0, keys: 0, token: 0 });

    // The password still signs in from this address, in the same minute.
    expect((await login()).status).toBe(200);
    // And the count of this feature is where it was: every one of its starts
    // is still there to be used, and the one after them is not.
    for (let attempt = 0; attempt < OIDC_ATTEMPTS; attempt += 1) {
      expect((await here.ask('GET', '/api/ee/oidc/start', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(302);
    }
    const over = await here.ask('GET', '/api/ee/oidc/start');
    expect([over.status, over.code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('using every sign-in this feature allows leaves the password its own', async () => {
    here = await install();
    here.minutes(2);
    for (let attempt = 0; attempt < OIDC_ATTEMPTS + 5; attempt += 1) {
      await here.ask('GET', '/api/ee/oidc/start');
    }
    expect((await here.ask('GET', '/api/ee/oidc/start')).code).toBe('RATE_LIMITED');
    expect((await login()).status).toBe(200);
  });

  it('one address makes the provider answer a bounded number of times a minute', async () => {
    here = await install();
    await connect();
    here.minutes(2);
    const asked = here.provider.calls.token;
    let signedIn = 0;
    let refused = 0;
    for (let attempt = 0; attempt < OIDC_ATTEMPTS; attempt += 1) {
      const start = await here.ask('GET', '/api/ee/oidc/start');
      if (start.status !== 302) {
        refused += 1;
        continue;
      }
      const back = new URL(here.provider.authorize(start.location ?? ''));
      const answer = await here.ask('GET', `${back.pathname}${back.search}`, {
        cookie: `${FLOW}=${start.cookies[FLOW]?.value ?? ''}`,
      });
      if (answer.status === 303) signedIn += 1;
    }
    // A sign-in is a departure and a return, so half the count is people.
    expect(signedIn).toBe(OIDC_ATTEMPTS / 2);
    expect(refused).toBe(OIDC_ATTEMPTS / 2);
    expect(here.provider.calls.token - asked).toBe(OIDC_ATTEMPTS / 2);
    // A minute later the address may again.
    here.minutes(2);
    expect((await here.ask('GET', '/api/ee/oidc/start')).status).toBe(302);
  });
});

// Taking away a way in to one's own account is a safety act, and is never
// the paid thing: a key that lapsed takes nothing away, and that includes
// being able to shut a door.
describe('with no licence key', () => {
  it('an account still reads its own connection and can still disconnect', async () => {
    here = await install({ licensed: false });
    await here.store.linkIdentity({
      issuer: here.provider.issuer,
      subject: 'provider-user-1',
      userId: here.owner.userId,
      linkedAt: Date.now(),
    });
    const status = await here.ask('GET', '/api/ee/oidc/identity', { cookie: here.owner.cookie });
    expect([status.status, status.data]).toEqual([
      200,
      { enabled: false, connected: true, canDisconnect: true },
    ]);
    // Still a person, and still held to this dashboard.
    const elsewhere = await here.ask('DELETE', '/api/ee/oidc/identity', {
      cookie: here.owner.cookie,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect([elsewhere.status, elsewhere.code]).toEqual([403, 'CROSS_SITE_REQUEST']);
    expect((await here.ask('DELETE', '/api/ee/oidc/identity')).status).toBe(401);

    const gone = await here.ask('DELETE', '/api/ee/oidc/identity', { cookie: here.owner.cookie });
    expect([gone.status, gone.data]).toEqual([200, { connected: false }]);
    expect(await here.store.identitiesForUser(here.owner.userId)).toEqual([]);
    expect(await here.rows('identity:unlink')).toHaveLength(1);
    // Connecting is the paid thing, and is still refused for the key.
    const link = await here.ask('POST', '/api/ee/oidc/link', { cookie: here.owner.cookie, payload: {} });
    expect([link.status, link.code]).toEqual([403, 'LICENSE_REQUIRED']);
  });
});

describe('an account another application signs in', () => {
  it('is not connected here: it is that application that says how it signs in', async () => {
    here = await install();
    here.minutes(2);
    const arrived = await here.ask(
      'GET',
      `/api/sso?token=${signHs256(
        'test-sso-secret-not-a-real-key-000000',
        ssoClaimsFor({
          sub: 'staff_9',
          email: 'staff9@elsewhere.example',
          teamId: TEAM_ID,
          role: 'viewer',
          now: Date.now() + 2 * MINUTE,
          lifetimeSeconds: 300,
        }),
      )}`,
    );
    expect(arrived.status).toBe(303);
    const managed = `${SESSION}=${arrived.cookies[SESSION]?.value ?? ''}`;
    const link = await here.ask('POST', '/api/ee/oidc/link', { cookie: managed, payload: {} });
    expect([link.status, link.code]).toEqual([409, 'MANAGED_BY_SSO']);
    expect(link.cookies[FLOW]).toBeUndefined();
    expect(await here.store.identitiesForUser('sso_staff_9')).toEqual([]);
  });
});
