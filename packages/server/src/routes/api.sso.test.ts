import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, envelope, expectFailure, NOW, type Harness } from './api.test-utils.js';
import { signHs256 } from '../lib/jwt.js';
import { SESSION_COOKIE } from '../services/auth.service.js';
import { ssoClaimsFor } from '../services/sso.service.js';

// The SSO exchange over HTTP, both forms.
//
// The secret here is the one vitest.config.ts puts in the environment for this
// package: a placeholder, never a real key.

const SECRET = 'test-sso-secret-not-a-real-key-000000';

function token(overrides: Partial<Parameters<typeof ssoClaimsFor>[0]> = {}): string {
  return signHs256(
    SECRET,
    ssoClaimsFor({
      sub: 'staff_7',
      email: 'staff@progsity.test',
      name: 'Staff Seven',
      teamId: 't_test',
      role: 'viewer',
      now: NOW,
      lifetimeSeconds: 300,
      ...overrides,
    }),
  );
}

describe('the SSO exchange', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('turns a token into a session and provisions the account', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/sso',
      payload: { token: token() },
    });

    expect(response.statusCode).toBe(200);
    const body = envelope<{ user: { id: string; email: string; name: string } }>(response.body);
    expect(body.data?.user.email).toBe('staff@progsity.test');
    expect(body.data?.user.name).toBe('Staff Seven');
    expect(response.cookies[0]?.name).toBe(SESSION_COOKIE);
    expect(response.cookies[0]?.httpOnly).toBe(true);

    // And the cookie works: they can read the site their membership names.
    const cookie = `${SESSION_COOKIE}=${response.cookies[0]?.value}`;
    const me = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    const sites = envelope<{ sites: { id: string; role: string }[] }>(me.body).data?.sites;
    expect(sites?.[0]?.role).toBe('viewer');
  });

  it('honours the role and the identity flag the token names', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/sso',
      payload: { token: token({ role: 'editor', identity: true }) },
    });
    const userId = envelope<{ user: { id: string } }>(response.body).data?.user.id;
    const team = await harness.store.team('t_test');
    expect(team?.members.find((member) => member.userId === userId)).toEqual({
      userId,
      role: 'editor',
      identity: true,
    });
  });

  // The whole reason a five minute token in a URL is acceptable.
  it('refuses a token that has already been exchanged', async () => {
    const one = token();
    expect(
      (await harness.app.inject({ method: 'POST', url: '/api/sso', payload: { token: one } }))
        .statusCode,
    ).toBe(200);
    expectFailure(
      await harness.app.inject({ method: 'POST', url: '/api/sso', payload: { token: one } }),
      401,
      'TOKEN_ALREADY_USED',
    );
  });

  it('refuses a token signed with the wrong secret, and one with no token at all', async () => {
    const forged = signHs256(
      'a-completely-different-secret-00000',
      ssoClaimsFor({ sub: 'staff_7', email: 'x@y.test', now: NOW, lifetimeSeconds: 300 }),
    );
    expectFailure(
      await harness.app.inject({ method: 'POST', url: '/api/sso', payload: { token: forged } }),
      401,
      'BAD_SIGNATURE',
    );
    expectFailure(
      await harness.app.inject({ method: 'POST', url: '/api/sso', payload: {} }),
      400,
      'INVALID_BODY',
    );
  });

  it('refuses a token claiming a longer life than five minutes', async () => {
    expectFailure(
      await harness.app.inject({
        method: 'POST',
        url: '/api/sso',
        payload: { token: token({ lifetimeSeconds: 86_400 }) },
      }),
      401,
      'TOKEN_TOO_LONG',
    );
  });

  // The link in an admin panel: a top level navigation that lands on the dashboard
  // already signed in.
  it('sets the cookie and redirects on the GET form', async () => {
    const response = await harness.app.inject({ method: 'GET', url: `/api/sso?token=${token()}` });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/');
    expect(response.cookies[0]?.name).toBe(SESSION_COOKIE);
  });

  it('follows a next path of this dashboard', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sso?token=${token()}&next=${encodeURIComponent('/realtime?site=s_test')}`,
    });
    expect(response.headers.location).toBe('/realtime?site=s_test');
  });

  // An open redirect behind a sign-in hop is how a trusted link becomes a phishing
  // link.
  it('refuses a next that leaves this dashboard', async () => {
    for (const next of ['https://evil.test/', '//evil.test/', 'http://evil.test']) {
      expectFailure(
        await harness.app.inject({
          method: 'GET',
          url: `/api/sso?token=${token()}&next=${encodeURIComponent(next)}`,
        }),
        400,
        'INVALID_QUERY',
      );
    }
  });

  // A five minute token that has expired, or a jti a double click already
  // burned, is the ordinary case rather than the strange one. The GET form is a
  // top level navigation, so answering it with a JSON body leaves an error
  // object in the address bar of what should have been a sign in page.
  describe('a refusal a person can read', () => {
    const html = { accept: 'text/html,application/xhtml+xml' };

    it('sends a browser to the sign in page with the reason', async () => {
      const expired = token({ now: NOW - 3_600_000 });
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sso?token=${expired}`,
        headers: html,
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('/login?sso=TOKEN_EXPIRED');
      expect(response.cookies).toHaveLength(0);
    });

    it('sends a browser there for a token that was already used', async () => {
      const one = token();
      await harness.app.inject({ method: 'GET', url: `/api/sso?token=${one}` });
      const again = await harness.app.inject({
        method: 'GET',
        url: `/api/sso?token=${one}`,
        headers: html,
      });
      expect(again.statusCode).toBe(303);
      expect(again.headers.location).toMatch(/^\/login\?sso=/);
    });

    it('sends a browser there when the token is missing altogether', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/sso',
        headers: html,
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('/login?sso=INVALID_QUERY');
    });

    // Rule 6 still holds for everything that is not a browser.
    it('still answers a program with the envelope', async () => {
      expectFailure(
        await harness.app.inject({
          method: 'GET',
          url: `/api/sso?token=${token({ now: NOW - 3_600_000 })}`,
          headers: { accept: 'application/json' },
        }),
        401,
        'TOKEN_EXPIRED',
      );
    });
  });
});

// The exchange under the last-owner rule, over HTTP (AN-TEAM01). The service's
// own tests hold the rule; these hold what a browser and a cookie see of it.
describe('the SSO exchange and the role it carries', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const html = { accept: 'text/html' };

  async function arrive(overrides: Parameters<typeof token>[0]): Promise<string> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/sso',
      payload: { token: token(overrides) },
    });
    expect(response.statusCode).toBe(200);
    return `${response.cookies[0]?.name}=${response.cookies[0]?.value}`;
  }

  function me(cookie: string) {
    return harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  }

  it('ends the session somebody had when they arrive lowered, and the new one lives', async () => {
    // An owner beside the install's own owner, who has a password.
    const before = await arrive({ role: 'owner', identity: true });
    expect((await me(before)).statusCode).toBe(200);

    const after = await arrive({ role: 'viewer', identity: false });
    expectFailure(await me(before), 401, 'UNAUTHENTICATED');
    const now = envelope<{ sites: { scopes: string[] }[] }>((await me(after)).body).data;
    expect(now?.sites[0]?.scopes).toEqual(['read:stats']);
  });

  it('leaves the session alone on an arrival that changes nothing, and on one that raises', async () => {
    const first = await arrive({ role: 'viewer' });
    const second = await arrive({ role: 'viewer' });
    const raised = await arrive({ role: 'editor' });
    for (const cookie of [first, second, raised]) {
      expect((await me(cookie)).statusCode).toBe(200);
    }
  });

  it('sends a browser to the sign in page, with no cookie, when the token would lower the last owner', async () => {
    // A team made by the exchange, of accounts with no password: its one owner.
    const made = await harness.app.inject({
      method: 'GET',
      url: `/api/sso?token=${token({ teamId: 't_made_here', role: 'owner' })}`,
      headers: html,
    });
    expect(made.statusCode).toBe(303);
    expect(made.headers.location).toBe('/');

    const refused = await harness.app.inject({
      method: 'GET',
      url: `/api/sso?token=${token({ teamId: 't_made_here', role: 'viewer' })}`,
      headers: html,
    });
    expect(refused.statusCode).toBe(303);
    expect(refused.headers.location).toBe('/login?sso=LAST_OWNER');
    expect(refused.cookies.find((cookie) => cookie.name === SESSION_COOKIE)).toBeUndefined();
    // A program is told the same thing in the envelope.
    expectFailure(
      await harness.app.inject({
        method: 'POST',
        url: '/api/sso',
        payload: { token: token({ teamId: 't_made_here', role: 'editor' }) },
      }),
      409,
      'LAST_OWNER',
    );
    expect((await harness.store.team('t_made_here'))?.members).toEqual([
      { userId: 'sso_staff_7', role: 'owner', identity: false },
    ]);
  });
});

// Both forms of the exchange count on a count of their own, never on the
// password's, and a GET that the browser says is not a navigation is refused
// before it is counted (the review of AN-TEAM01). The GET form is a link
// another application sends somebody along, so it is a request any page can
// make a browser send: an image tag pointed at it must not use up what an
// address has left to sign in with.
describe("the exchange's own count", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  // What a browser sends for an <img> on another site's page.
  const image = {
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-dest': 'image',
    'sec-fetch-site': 'cross-site',
    accept: 'image/avif,image/webp,*/*',
  };
  // And for a person following a link from another application.
  const followed = {
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-site': 'cross-site',
    accept: 'text/html,application/xhtml+xml',
  };

  async function wrongPassword(): Promise<number> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@test.example', password: 'not-the-password-at-all' },
    });
    return response.statusCode;
  }

  it('leaves the password and the exchange usable after a page of image requests', async () => {
    for (let index = 0; index < 40; index += 1) {
      expectFailure(
        await harness.app.inject({ method: 'GET', url: `/api/sso?token=${token()}`, headers: image }),
        403,
        'NOT_A_NAVIGATION',
      );
    }
    // Nothing above was counted, and nothing was exchanged.
    expect(await harness.signIn('owner@test.example')).toContain(SESSION_COOKIE);
    const arrived = await harness.app.inject({
      method: 'GET',
      url: `/api/sso?token=${token()}`,
      headers: followed,
    });
    expect(arrived.statusCode).toBe(303);
    expect(arrived.headers.location).toBe('/');
    expect(arrived.cookies[0]?.name).toBe(SESSION_COOKIE);
  });

  // A hidden frame is a navigation too, so the page itself is asked for as
  // well (the review of part 0).
  it('refuses a navigation into a frame, by either form, and counts neither', async () => {
    const framed = { ...followed, 'sec-fetch-dest': 'iframe' };
    for (let index = 0; index < 12; index += 1) {
      const get = await harness.app.inject({ method: 'GET', url: `/api/sso?token=${token()}`, headers: framed });
      expectFailure(get, 403, 'NOT_A_NAVIGATION');
      expect(get.cookies).toHaveLength(0);
      expectFailure(
        await harness.app.inject({
          method: 'POST',
          url: '/api/sso',
          headers: { ...framed, 'content-type': 'application/json' },
          payload: { token: token() },
        }),
        403,
        'NOT_A_NAVIGATION',
      );
    }
    // Twenty-four refusals, and the count of ten untouched.
    const arrived = await harness.app.inject({ method: 'GET', url: `/api/sso?token=${token()}`, headers: followed });
    expect(arrived.statusCode).toBe(303);
  });

  // The POST form is for a program, which sends no Sec-Fetch header; a page's
  // fetch is refused before it is counted, and a form a person submits is a
  // navigation and taken.
  it('refuses a POST a page makes, and takes a program and a person submitting a form', async () => {
    for (const mode of ['no-cors', 'cors', 'same-origin']) {
      expectFailure(
        await harness.app.inject({
          method: 'POST',
          url: '/api/sso',
          headers: {
            'sec-fetch-mode': mode,
            'sec-fetch-dest': 'empty',
            'sec-fetch-site': 'cross-site',
            'content-type': 'text/plain',
          },
          payload: JSON.stringify({ token: token() }),
        }),
        403,
        'NOT_A_NAVIGATION',
      );
    }
    const program = await harness.app.inject({ method: 'POST', url: '/api/sso', payload: { token: token() } });
    expect(program.statusCode).toBe(200);
    const submitted = await harness.app.inject({
      method: 'POST',
      url: '/api/sso',
      headers: { ...followed, 'content-type': 'application/json' },
      payload: { token: token() },
    });
    expect(submitted.statusCode).toBe(200);
  });

  it('refuses every kind of request a page makes that is not following a link', async () => {
    for (const mode of ['no-cors', 'cors', 'same-origin', 'websocket', 'NO-CORS']) {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sso?token=${token()}`,
        headers: { 'sec-fetch-mode': mode },
      });
      expectFailure(response, 403, 'NOT_A_NAVIGATION');
      expect(response.cookies).toHaveLength(0);
    }
  });

  // Another site is where the exchange is entered from: that is not refused.
  it('takes a person sent from another site, and a program that says nothing', async () => {
    const sent = await harness.app.inject({
      method: 'GET',
      url: `/api/sso?token=${token()}&next=${encodeURIComponent('/s_test')}`,
      headers: followed,
    });
    expect([sent.statusCode, sent.headers.location]).toEqual([303, '/s_test']);
    const program = await harness.app.inject({ method: 'GET', url: `/api/sso?token=${token()}` });
    expect(program.statusCode).toBe(303);
  });

  it('counts the exchange apart from the password, both ways', async () => {
    const limit = 10;
    // The exchange's count used up, by both forms.
    for (let index = 0; index < limit; index += 1) {
      const response =
        index % 2 === 0
          ? await harness.app.inject({ method: 'POST', url: '/api/sso', payload: { token: 'not.a.token' } })
          : await harness.app.inject({ method: 'GET', url: '/api/sso?token=not.a.token', headers: followed });
      expect(response.statusCode).not.toBe(429);
    }
    expectFailure(
      await harness.app.inject({ method: 'POST', url: '/api/sso', payload: { token: token() } }),
      429,
      'RATE_LIMITED',
    );
    expectFailure(
      await harness.app.inject({
        method: 'GET',
        url: `/api/sso?token=${token()}`,
        headers: { accept: 'application/json' },
      }),
      429,
      'RATE_LIMITED',
    );
    // The password is untouched by it.
    expect(await harness.signIn('owner@test.example')).toContain(SESSION_COOKIE);

    // And the other way, a minute later: the password's count used up leaves
    // the exchange working.
    harness.setNow(harness.now() + 61_000);
    for (let index = 0; index < limit; index += 1) {
      expect(await wrongPassword()).toBe(401);
    }
    expect(await wrongPassword()).toBe(429);
    const exchanged = await harness.app.inject({ method: 'POST', url: '/api/sso', payload: { token: token({ now: harness.now() }) } });
    expect(exchanged.statusCode).toBe(200);
  });
});
