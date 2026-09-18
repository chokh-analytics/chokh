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
});
