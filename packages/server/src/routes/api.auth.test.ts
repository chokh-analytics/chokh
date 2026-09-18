import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBareApp,
  createHarness,
  envelope,
  expectFailure,
  OWNER_EMAIL,
  PASSWORD,
  SITE_ID,
  type Harness,
} from './api.test-utils.js';
import { SESSION_COOKIE } from '../services/auth.service.js';

// Registration, sign-in and who am I, over HTTP.

describe('the first account', () => {
  let bare: Awaited<ReturnType<typeof createBareApp>>;

  beforeEach(async () => {
    bare = await createBareApp();
  });

  afterEach(async () => {
    await bare.close();
  });

  // An install with no way to make the first account is an install nobody can use.
  it('registers itself, is signed in, and owns the default team', async () => {
    const response = await bare.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'first@test.example', password: PASSWORD, name: 'First' },
    });

    expect(response.statusCode).toBe(201);
    const body = envelope<{ user: { id: string; email: string }; signedIn: boolean }>(response.body);
    expect(body.success).toBe(true);
    expect(body.data?.signedIn).toBe(true);
    expect(body.data?.user.email).toBe('first@test.example');
    expect(response.cookies[0]?.name).toBe(SESSION_COOKIE);
    expect(response.cookies[0]?.httpOnly).toBe(true);
    expect(response.cookies[0]?.sameSite).toBe('Lax');

    const team = await bare.store.team('default');
    expect(team?.members).toEqual([
      { userId: body.data?.user.id, role: 'owner', identity: true },
    ]);
  });

  it('never returns a password hash, whatever else it returns', async () => {
    const response = await bare.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'first@test.example', password: PASSWORD },
    });
    expect(response.body).not.toContain('argon2');
    expect(response.body).not.toContain('passwordHash');
  });

  it('refuses a password too short to be worth hashing', async () => {
    const response = await bare.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'first@test.example', password: 'short' },
    });
    expectFailure(response, 400, 'INVALID_BODY');
  });

  it('refuses a second stranger once somebody is here', async () => {
    await bare.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'first@test.example', password: PASSWORD },
    });
    const response = await bare.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'second@test.example', password: PASSWORD },
    });
    expectFailure(response, 403, 'FORBIDDEN');
    expect(await bare.store.userCount()).toBe(1);
  });
});

describe('signing in', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('answers with the account and sets the session cookie', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: OWNER_EMAIL, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(envelope<{ user: { email: string } }>(response.body).data?.user.email).toBe(OWNER_EMAIL);
    expect(response.cookies[0]?.name).toBe(SESSION_COOKIE);
  });

  // "No such account" tells somebody which addresses are worth guessing at.
  it('answers the same refusal for a wrong password and for an address nobody uses', async () => {
    const wrongPassword = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: OWNER_EMAIL, password: 'not-the-right-password' },
    });
    const noSuchAccount = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@test.example', password: PASSWORD },
    });
    expectFailure(wrongPassword, 401, 'INVALID_CREDENTIALS');
    expectFailure(noSuchAccount, 401, 'INVALID_CREDENTIALS');
    expect(wrongPassword.body).toBe(noSuchAccount.body);
  });

  it('signs out by clearing the cookie', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: harness.owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.cookies[0]?.name).toBe(SESSION_COOKIE);
    expect(response.cookies[0]?.value).toBe('');
  });
});

// Per address, not per account: per account is how somebody locks a person out of
// their own dashboard by guessing at them. On a bare app, so the attempts counted
// are exactly the ones these cases make.
describe('the gate in front of signing in', () => {
  let bare: Awaited<ReturnType<typeof createBareApp>>;

  beforeEach(async () => {
    bare = await createBareApp();
  });

  afterEach(async () => {
    await bare.close();
  });

  function guess() {
    return bare.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@test.example', password: 'not-the-right-password' },
    });
  }

  it('lets ten attempts a minute through and refuses the eleventh', async () => {
    for (let tries = 0; tries < 10; tries += 1) {
      expectFailure(await guess(), 401, 'INVALID_CREDENTIALS');
    }
    expectFailure(await guess(), 429, 'RATE_LIMITED');
  });

  // One counter for every way in, so somebody who has run out of login attempts
  // cannot carry on guessing at the registration route or at SSO.
  it('counts registration and both SSO forms against the same address', async () => {
    for (let tries = 0; tries < 10; tries += 1) {
      await guess();
    }
    expectFailure(
      await bare.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'another@test.example', password: PASSWORD },
      }),
      429,
      'RATE_LIMITED',
    );
    expectFailure(
      await bare.app.inject({ method: 'POST', url: '/api/sso', payload: { token: 'x' } }),
      429,
      'RATE_LIMITED',
    );
    expectFailure(
      await bare.app.inject({ method: 'GET', url: '/api/sso?token=x' }),
      429,
      'RATE_LIMITED',
    );
  });
});

describe('GET /api/me', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('says who the caller is and what they may do to each site', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: harness.owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = envelope<{
      actor: { kind: string; id: string };
      user: { email: string };
      sites: { id: string; role: string; scopes: string[] }[];
    }>(response.body);
    expect(body.data?.actor.kind).toBe('session');
    expect(body.data?.user.email).toBe(OWNER_EMAIL);
    expect(body.data?.sites).toHaveLength(1);
    expect(body.data?.sites[0]?.id).toBe(SITE_ID);
    expect(body.data?.sites[0]?.role).toBe('owner');
    expect(body.data?.sites[0]?.scopes).toEqual([
      'admin',
      'read:identity',
      'read:stats',
      'write:events',
    ]);
  });

  it('shows a viewer their smaller scope list', async () => {
    const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: viewer.cookie },
    });
    const sites = envelope<{ sites: { role: string; scopes: string[] }[] }>(response.body).data
      ?.sites;
    expect(sites?.[0]?.role).toBe('viewer');
    expect(sites?.[0]?.scopes).toEqual(['read:stats']);
  });

  it('shows nothing to somebody in no team that owns a site', async () => {
    const outsider = await harness.account({
      email: 'outsider@test.example',
      role: 'viewer',
      teamId: 'default',
    });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: outsider.cookie },
    });
    expect(envelope<{ sites: unknown[] }>(response.body).data?.sites).toEqual([]);
  });

  it('tells a key what it is, so an integration need not guess at its own scopes', async () => {
    const key = await harness.key(['read:stats']);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: key },
    });
    const body = envelope<{
      actor: { kind: string };
      user: null;
      sites: { scopes: string[] }[];
    }>(response.body);
    expect(body.data?.actor.kind).toBe('key');
    expect(body.data?.user).toBeNull();
    expect(body.data?.sites[0]?.scopes).toEqual(['read:stats']);
  });

  it('refuses nobody with the envelope, not with a framework error', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/me' });
    expectFailure(response, 401, 'UNAUTHENTICATED');
  });

  it('refuses a cookie somebody edited', async () => {
    const forged = `${SESSION_COOKIE}=eyJ1aWQiOiJ1X2FkbWluIiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.nope`;
    expectFailure(
      await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: forged } }),
      401,
      'UNAUTHENTICATED',
    );
  });
});

describe('PUT /api/teams/:teamId/members/:userId', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('lets an owner add a member and then change their role', async () => {
    const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/api/teams/t_test/members/${viewer.userId}`,
      headers: { cookie: harness.owner.cookie },
      payload: { role: 'editor', identity: true },
    });
    expect(response.statusCode).toBe(200);
    const team = await harness.store.team('t_test');
    expect(team?.members.find((member) => member.userId === viewer.userId)).toEqual({
      userId: viewer.userId,
      role: 'editor',
      identity: true,
    });
  });

  it('refuses a member who is not an owner of that team', async () => {
    const editor = await harness.account({ email: 'editor@test.example', role: 'editor' });
    expectFailure(
      await harness.app.inject({
        method: 'PUT',
        url: `/api/teams/t_test/members/${editor.userId}`,
        headers: { cookie: editor.cookie },
        payload: { role: 'owner' },
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('refuses a team and an account that do not exist', async () => {
    expectFailure(
      await harness.app.inject({
        method: 'PUT',
        url: `/api/teams/t_nothing/members/${harness.owner.userId}`,
        headers: { cookie: harness.owner.cookie },
        payload: { role: 'viewer' },
      }),
      404,
      'UNKNOWN_TEAM',
    );
    expectFailure(
      await harness.app.inject({
        method: 'PUT',
        url: '/api/teams/t_test/members/u_nobody',
        headers: { cookie: harness.owner.cookie },
        payload: { role: 'viewer' },
      }),
      404,
      'UNKNOWN_USER',
    );
  });
});
