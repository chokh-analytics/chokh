import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  buildApp,
  ok,
  requireSiteScope,
  type ApiDeps,
  type ServerExtension,
} from '@chokh/server';
import { createMemoryStore } from '@chokh/server/store/memory';
import { defaultSiteSettings } from '@chokh/server/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildExtension } from '../extension.js';
import { requireLicense } from '../license/guard.js';
import { ALL_FEATURES, type LicensePayload } from '../license/payload.js';
import { createLicenseState } from '../license/state.js';
import { publicKeyToBase64, signLicense } from '../license/token.js';
import { PING_FEATURE } from './ee.routes.js';

// The gate, over HTTP, against the real server.
//
// The unit tests say what verifyLicense decides. What only this can say is what
// a caller actually receives: the status, the envelope, the order the two hooks
// run in, and which feature name ends up in the details. Every one of those is
// a seam between this package and the core, and a seam is where the mistakes
// live.
//
// Throwaway pair per run, in memory. Nothing here, in the image or in CI ever
// holds the product's own private key.

const SITE_ID = 's_test';
const TEAM_ID = 'default';
const OWNER = { email: 'owner@test.example', password: 'a-password-long-enough' };
const DAY = 86_400;

function pair(): { privateKey: string; publicKey: string } {
  const generated = generateKeyPairSync('ed25519');
  return {
    privateKey: generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKeyToBase64(
      generated.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    ),
  };
}

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    id: 'lic_test',
    licensee: 'A Test Company Ltd.',
    plan: 'pro',
    features: [ALL_FEATURES],
    seats: null,
    sites: null,
    issuedAt,
    expiresAt: issuedAt + 365 * DAY,
    ...over,
  };
}

interface Install {
  app: FastifyInstance;
  cookie: string;
  close(): Promise<void>;
}

async function install(extensions: ServerExtension[]): Promise<Install> {
  const store = createMemoryStore();
  const app = await buildApp({ store, extensions });
  await app.ready();

  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: OWNER.email, password: OWNER.password },
  });
  const cookie = `${registered.cookies[0]?.name}=${registered.cookies[0]?.value}`;
  await store.createSite({
    id: SITE_ID,
    name: 'Test site',
    domains: ['test.example'],
    teamId: TEAM_ID,
    settings: defaultSiteSettings({ timezone: 'UTC', identifySecret: 'test-identify-secret' }),
  });

  return { app, cookie, close: () => app.close() };
}

function refusal(body: string): { code: string; details: { feature: string; reason: string } } {
  const parsed = JSON.parse(body) as {
    success: boolean;
    error: { code: string; details: { feature: string; reason: string } };
  };
  expect(parsed.success).toBe(false);
  return { code: parsed.error.code, details: parsed.error.details };
}

describe('a paid route on an install with no key', () => {
  let here: Install;

  beforeEach(async () => {
    here = await install([buildExtension({ raw: undefined, publicKeys: [] })]);
  });

  afterEach(async () => {
    await here.close();
  });

  it('answers 403 LICENSE_REQUIRED in the envelope, naming the feature', async () => {
    const response = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/ping`,
      headers: { cookie: here.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(refusal(response.body)).toEqual({
      code: 'LICENSE_REQUIRED',
      details: { feature: PING_FEATURE, reason: 'missing' },
    });
  });

  // The scope hook first, always. Somebody guessing at paths must not be told
  // which paid feature lives behind one, and an anonymous 403 about licensing
  // would say exactly that.
  it('refuses a caller with no session for the session, not for the licence', async () => {
    const response = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/ping`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('LICENSE_REQUIRED');
    expect(response.body).not.toContain(PING_FEATURE);
  });

  it('says there is no licence rather than drawing a blank', async () => {
    const response = await here.app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: here.cookie },
    });

    expect(JSON.parse(response.body).data).toEqual({
      licensed: false,
      plan: null,
      licensee: null,
      expiresAt: null,
      features: [],
    });
  });
});

describe('a paid route on an install with a key', () => {
  it('runs the feature, and says so on the licence route', async () => {
    const issuer = pair();
    const here = await install([
      buildExtension({
        raw: signLicense(issuer.privateKey, payload()),
        publicKeys: [issuer.publicKey],
      }),
    ]);

    const ping = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/ping`,
      headers: { cookie: here.cookie },
    });
    expect(ping.statusCode).toBe(200);
    expect(JSON.parse(ping.body).data).toEqual({ pong: true, feature: PING_FEATURE });

    const license = await here.app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: here.cookie },
    });
    expect(JSON.parse(license.body).data).toMatchObject({
      licensed: true,
      plan: 'pro',
      licensee: 'A Test Company Ltd.',
      features: [ALL_FEATURES],
    });

    await here.close();
  });

  it.each([
    [
      'a key that has expired',
      (issuer: { privateKey: string }) =>
        signLicense(
          issuer.privateKey,
          payload({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
        ),
      'expired',
    ],
    [
      'a key that does not name this feature',
      (issuer: { privateKey: string }) =>
        signLicense(issuer.privateKey, payload({ features: ['something-else'] })),
      'not_licensed',
    ],
    ['a key that is not a key at all', () => 'not-even-close', 'malformed'],
  ])('refuses %s', async (_name, mint, reason) => {
    const issuer = pair();
    const here = await install([
      buildExtension({ raw: mint(issuer), publicKeys: [issuer.publicKey] }),
    ]);

    const response = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/ping`,
      headers: { cookie: here.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(refusal(response.body).details).toEqual({ feature: PING_FEATURE, reason });
    await here.close();
  });

  // A key signed by somebody who is not this build's issuer. The route is shut
  // and the dashboard says no licence, which is the same thing a stranger's own
  // key gets on a public image.
  it('refuses a key from another issuer, and reports no licence', async () => {
    const issuer = pair();
    const stranger = pair();
    const here = await install([
      buildExtension({
        raw: signLicense(stranger.privateKey, payload()),
        publicKeys: [issuer.publicKey],
      }),
    ]);

    const ping = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/ping`,
      headers: { cookie: here.cookie },
    });
    expect(refusal(ping.body).details.reason).toBe('bad_signature');

    const license = await here.app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: here.cookie },
    });
    expect(JSON.parse(license.body).data.licensed).toBe(false);

    await here.close();
  });

  // The clock is read per request and the signature is not. A process that has
  // been up since before midnight has to stop at midnight.
  it('stops serving the moment the key expires, without a restart', async () => {
    const issuer = pair();
    const expiresAt = Math.floor(Date.now() / 1000) + 1;
    const here = await install([
      buildExtension({
        raw: signLicense(issuer.privateKey, payload({ expiresAt })),
        publicKeys: [issuer.publicKey],
      }),
    ]);

    const before = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/ping`,
      headers: { cookie: here.cookie },
    });
    expect(before.statusCode).toBe(200);

    await new Promise((wake) => setTimeout(wake, 1_100));

    const after = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/ping`,
      headers: { cookie: here.cookie },
    });
    expect(after.statusCode).toBe(403);
    expect(refusal(after.body).details.reason).toBe('expired');

    // And the dashboard is told the date rather than "you never had one", so a
    // renewal does not read as a purchase.
    const license = await here.app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: here.cookie },
    });
    expect(JSON.parse(license.body).data).toMatchObject({
      licensed: false,
      licensee: 'A Test Company Ltd.',
      expiresAt: expiresAt * 1000,
    });

    await here.close();
  });
});

// Ruling 3, and the reason for it: a preHandler array hoisted into a const and
// reused across routes gave every route in the Progsity workspace the first
// route's rate limiter, and nothing but an HTTP probe found it. The same shape
// here would give every paid route the first one's feature name, so a key
// naming alerts would quietly open replay.
//
// Two routes, two features, one key that names only the first. Over HTTP,
// because that is the only place the bug is visible: the factory looks right in
// isolation either way.
describe('two paid routes, each naming its own feature', () => {
  it('gates each route by its own name and says which in the details', async () => {
    const issuer = pair();
    const state = createLicenseState({
      raw: signLicense(issuer.privateKey, payload({ features: ['first.feature'] })),
      publicKeys: [issuer.publicKey],
    });

    const twoRoutes: ServerExtension = {
      name: 'two-routes',
      register: async (app, deps: ApiDeps) => {
        const auth = { store: deps.store, session: deps.session, now: deps.now };
        app.get(
          `/api/sites/:siteId/ee/first`,
          {
            preHandler: [
              requireSiteScope(auth, 'read:stats'),
              requireLicense(state, 'first.feature'),
            ],
          },
          () => ok({ which: 'first' }),
        );
        app.get(
          `/api/sites/:siteId/ee/second`,
          {
            preHandler: [
              requireSiteScope(auth, 'read:stats'),
              requireLicense(state, 'second.feature'),
            ],
          },
          () => ok({ which: 'second' }),
        );
      },
    };

    const here = await install([twoRoutes]);
    const headers = { cookie: here.cookie };

    const first = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/first`,
      headers,
    });
    expect(first.statusCode).toBe(200);

    const second = await here.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/ee/second`,
      headers,
    });
    expect(second.statusCode).toBe(403);
    // The second route's own name, not the first's. This is the whole probe.
    expect(refusal(second.body).details).toEqual({
      feature: 'second.feature',
      reason: 'not_licensed',
    });

    await here.close();
  });
});
