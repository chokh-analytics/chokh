import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PASSWORD,
  SITE_ID,
  TEAM_ID,
  createHarness,
  envelope,
  expectFailure,
  testSite,
  type Harness,
} from './api.test-utils.js';
import { signHs256 } from '../lib/jwt.js';
import { ssoClaimsFor } from '../services/sso.service.js';
import type { Role, StoredInvitation } from '../store/AnalyticsStore.js';

// Who may reach a team or a site, and what follows when that changes
// (AN-TEAM01): a role on one site beside the role in its team, the routes that
// change either, the rule that keeps a team from losing its last owner, the
// sessions a lowering ends, the invitations it revokes and the keys it asks
// about.

const SIBLING = 's_sibling';
const SPARE_TEAM = 't_spare';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({
    sites: [testSite(), testSite({ id: SIBLING, domains: ['sibling.example'] })],
  });
  await harness.store.createTeam({ id: SPARE_TEAM, name: 'Spare', members: [] });
});

afterEach(async () => {
  await harness.close();
});

interface Person {
  cookie: string;
  userId: string;
}

// An account is a registration and a sign-in, and both count against the
// limit on attempts from one address, so the clock moves on before each.
async function member(email: string, role: Role, identity = false): Promise<Person> {
  harness.setNow(harness.now() + 61_000);
  return harness.account({ email, role, identity });
}

// Somebody with an account and no place in any team.
async function guest(email: string): Promise<Person> {
  harness.setNow(harness.now() + 61_000);
  const made = await harness.account({ email, role: 'viewer', teamId: SPARE_TEAM });
  await harness.store.changeTeamMember(SPARE_TEAM, made.userId, null);
  return made;
}

function get(url: string, cookie: string) {
  return harness.app.inject({ method: 'GET', url, headers: { cookie } });
}

function send(method: 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) {
  return harness.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function scopesOn(siteId: string, cookie: string): Promise<string[] | number> {
  const response = await get(`/api/sites/${siteId}`, cookie);
  return response.statusCode === 200
    ? envelope<{ scopes: string[] }>(response.body).data?.scopes ?? []
    : response.statusCode;
}

const OWNER_SCOPES = ['admin', 'read:identity', 'read:stats', 'write:events'];

describe('a role on one site', () => {
  it('lets somebody with no place in the team read the one site they were given, and no other', async () => {
    const visitor = await guest('guest@test.example');
    expect(await scopesOn(SITE_ID, visitor.cookie)).toBe(403);

    await harness.store.setSiteMember({
      siteId: SITE_ID,
      userId: visitor.userId,
      role: 'viewer',
      identity: false,
    });
    expect(await scopesOn(SITE_ID, visitor.cookie)).toEqual(['read:stats']);
    // The site beside it, in the same team, is still not theirs.
    expectFailure(await get(`/api/sites/${SIBLING}`, visitor.cookie), 403, 'SITE_FORBIDDEN');
    // And the list of what they can read is that one site, with their role.
    const me = envelope<{ sites: { id: string; role: string }[]; teams: unknown[] }>(
      (await get('/api/me', visitor.cookie)).body,
    ).data;
    expect(me?.sites.map((site) => [site.id, site.role])).toEqual([[SITE_ID, 'viewer']]);
    expect(me?.teams).toEqual([]);
  });

  it('decides in place of the team role when there is one, up or down', async () => {
    const viewer = await member('viewer@test.example', 'viewer');
    const editor = await member('editor@test.example', 'editor', true);
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: viewer.userId, role: 'owner', identity: true });
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: editor.userId, role: 'viewer', identity: false });

    // Raised on this site, and only on this site.
    expect(await scopesOn(SITE_ID, viewer.cookie)).toEqual(OWNER_SCOPES);
    expect(await scopesOn(SIBLING, viewer.cookie)).toEqual(['read:stats']);
    // Lowered on this site, the identity flag with it, and only on this site.
    expect(await scopesOn(SITE_ID, editor.cookie)).toEqual(['read:stats']);
    expect(await scopesOn(SIBLING, editor.cookie)).toEqual([
      'read:identity',
      'read:stats',
      'write:events',
    ]);
    expectFailure(
      await get(`/api/sites/${SITE_ID}/users/u_anybody`, editor.cookie),
      403,
      'SCOPE_REQUIRED',
    );
  });

  it('never lowers an owner of the team, whatever a row on the site says', async () => {
    const second = await member('second@test.example', 'owner');
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: second.userId, role: 'viewer', identity: false });
    expect(await scopesOn(SITE_ID, second.cookie)).toEqual(OWNER_SCOPES);
    expect((await get(`/api/sites/${SITE_ID}/keys`, second.cookie)).statusCode).toBe(200);
  });

  it('is set, read and removed by somebody with admin on the site, and by nobody else', async () => {
    const visitor = await guest('guest@test.example');
    const editor = await member('editor@test.example', 'editor');
    const url = `/api/sites/${SITE_ID}/members/${visitor.userId}`;

    expectFailure(await send('PUT', url, editor.cookie, { role: 'viewer' }), 403, 'SCOPE_REQUIRED');
    // A key that holds admin is still not a person.
    const key = await harness.key(['admin']);
    expectFailure(
      await harness.app.inject({ method: 'PUT', url, headers: { authorization: key }, payload: { role: 'viewer' } }),
      403,
      'FORBIDDEN',
    );

    const set = await send('PUT', url, harness.owner.cookie, { role: 'editor', identity: true });
    expect(set.statusCode).toBe(200);
    expect(envelope<{ members: unknown[] }>(set.body).data?.members).toEqual([
      {
        userId: visitor.userId,
        email: 'guest@test.example',
        role: 'editor',
        identity: true,
        managed: false,
      },
    ]);
    expect(await scopesOn(SITE_ID, visitor.cookie)).toEqual([
      'read:identity',
      'read:stats',
      'write:events',
    ]);
    const list = await get(`/api/sites/${SITE_ID}/members`, harness.owner.cookie);
    expect(envelope<{ members: { userId: string }[] }>(list.body).data?.members).toHaveLength(1);

    expect((await send('DELETE', url, harness.owner.cookie)).statusCode).toBe(200);
    expectFailure(await send('DELETE', url, harness.owner.cookie), 404, 'UNKNOWN_MEMBER');
    expectFailure(
      await send('PUT', `/api/sites/${SITE_ID}/members/u_nobody`, harness.owner.cookie, { role: 'viewer' }),
      404,
      'UNKNOWN_USER',
    );
  });

  it('lets somebody who owns one site give out roles on that site and nowhere else', async () => {
    const siteOwner = await guest('site-owner@test.example');
    const visitor = await guest('guest@test.example');
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: siteOwner.userId, role: 'owner', identity: true });

    expect(
      (await send('PUT', `/api/sites/${SITE_ID}/members/${visitor.userId}`, siteOwner.cookie, { role: 'viewer' }))
        .statusCode,
    ).toBe(200);
    expectFailure(
      await send('PUT', `/api/sites/${SIBLING}/members/${visitor.userId}`, siteOwner.cookie, { role: 'viewer' }),
      403,
      'SITE_FORBIDDEN',
    );
    // Nor anything about the team that owns the site.
    expectFailure(await get(`/api/teams/${TEAM_ID}/members`, siteOwner.cookie), 403, 'FORBIDDEN');
    expectFailure(
      await send('PUT', `/api/teams/${TEAM_ID}/members/${visitor.userId}`, siteOwner.cookie, { role: 'viewer' }),
      403,
      'FORBIDDEN',
    );
  });
});

describe("a team's members", () => {
  it('are listed for an owner, with who each is and what they hold', async () => {
    const viewer = await member('viewer@test.example', 'viewer', true);
    const response = await get(`/api/teams/${TEAM_ID}/members`, harness.owner.cookie);
    expect(response.statusCode).toBe(200);
    const body = envelope<{ team: unknown; members: Record<string, unknown>[] }>(response.body).data;
    expect(body?.team).toEqual({ id: TEAM_ID, name: 'Test team' });
    expect(body?.members).toEqual([
      { userId: harness.owner.userId, email: 'owner@test.example', role: 'owner', identity: true, managed: false },
      { userId: viewer.userId, email: 'viewer@test.example', role: 'viewer', identity: true, managed: false },
    ]);
    // Nothing of an account that a list has no business carrying.
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('sessionEpoch');
    expectFailure(await get(`/api/teams/${TEAM_ID}/members`, viewer.cookie), 403, 'FORBIDDEN');
    expectFailure(await get('/api/teams/t_nothing/members', harness.owner.cookie), 404, 'UNKNOWN_TEAM');
  });

  it('can be renamed by an owner', async () => {
    const renamed = await send('PATCH', `/api/teams/${TEAM_ID}`, harness.owner.cookie, { name: '  Acme  ' });
    expect(envelope<{ team: unknown }>(renamed.body).data?.team).toEqual({ id: TEAM_ID, name: 'Acme' });
    expectFailure(await send('PATCH', `/api/teams/${TEAM_ID}`, harness.owner.cookie, { name: '' }), 400, 'INVALID_BODY');
  });

  it('keep an owner: the last one is neither lowered nor removed, by themselves or anybody', async () => {
    const url = `/api/teams/${TEAM_ID}/members/${harness.owner.userId}`;
    expectFailure(await send('PUT', url, harness.owner.cookie, { role: 'editor' }), 409, 'LAST_OWNER');
    expectFailure(await send('DELETE', url, harness.owner.cookie), 409, 'LAST_OWNER');
    expect((await harness.store.team(TEAM_ID))?.members).toEqual([
      { userId: harness.owner.userId, role: 'owner', identity: true },
    ]);
    // Still signed in: a refused change ended nothing.
    expect((await get('/api/me', harness.owner.cookie)).statusCode).toBe(200);

    // With a second owner, the first may step down, and is told what that did.
    const second = await member('second@test.example', 'owner');
    const stepped = await send('PUT', url, second.cookie, { role: 'viewer' });
    expect(stepped.statusCode).toBe(200);
    expect(envelope<unknown>(stepped.body).meta).toMatchObject({ sessionsEnded: true });
    expectFailure(
      await send('DELETE', `/api/teams/${TEAM_ID}/members/${second.userId}`, second.cookie),
      409,
      'LAST_OWNER',
    );
  });

  it('keep an owner with a password, so a team cannot be left to accounts that sign in elsewhere', async () => {
    // An owner who arrives through another application and has no password.
    await harness.store.createUser({ id: 'sso_staff_1', email: 'staff@test.example', createdAt: harness.now() });
    await harness.store.changeTeamMember(TEAM_ID, 'sso_staff_1', { role: 'owner', identity: true });
    expectFailure(
      await send('DELETE', `/api/teams/${TEAM_ID}/members/${harness.owner.userId}`, harness.owner.cookie),
      409,
      'LAST_OWNER',
    );
    expectFailure(
      await send('PUT', `/api/teams/${TEAM_ID}/members/${harness.owner.userId}`, harness.owner.cookie, {
        role: 'viewer',
      }),
      409,
      'LAST_OWNER',
    );
  });

  it('writes one row to the log of the team, saying who did what to whom', async () => {
    const viewer = await member('viewer@test.example', 'viewer');
    const url = `/api/teams/${TEAM_ID}/members/${viewer.userId}`;
    await send('PUT', url, harness.owner.cookie, { role: 'editor', identity: true });
    await send('DELETE', url, harness.owner.cookie);

    const page = await harness.store.auditPage({ scope: { kind: 'team', id: TEAM_ID }, limit: 10 });
    expect(page.rows.map((row) => [row.action, row.target, row.fields])).toEqual([
      ['member:remove', viewer.userId, ['role: editor+identity > none', 'sessions ended']],
      ['member:set', viewer.userId, ['role: viewer > editor+identity']],
    ]);
    expect(page.rows[0]?.actor).toEqual({
      kind: 'session',
      id: harness.owner.userId,
      email: 'owner@test.example',
    });
    expect(page.rows[0]?.route).toBe('DELETE /api/teams/:teamId/members/:userId');
    // About the team, so not in any site's log.
    expect((await harness.store.auditPage({ scope: { kind: 'site', id: SITE_ID }, limit: 10 })).rows).toEqual([]);
  });

  it("writes a change to one site's roles to that site's log", async () => {
    const visitor = await guest('guest@test.example');
    await send('PUT', `/api/sites/${SITE_ID}/members/${visitor.userId}`, harness.owner.cookie, { role: 'viewer' });
    const page = await harness.store.auditPage({ scope: { kind: 'site', id: SITE_ID }, limit: 10 });
    expect(page.rows.map((row) => [row.action, row.target, row.fields])).toEqual([
      ['member:set', visitor.userId, ['role: none > viewer']],
    ]);
    expect((await harness.store.auditPage({ scope: { kind: 'team', id: TEAM_ID }, limit: 10 })).rows).toEqual([]);
  });
});

describe('ending sessions', () => {
  it('signs somebody out everywhere the moment their role is lowered, and lets them back in as what they now are', async () => {
    const editor = await member('editor@test.example', 'editor');
    expect((await get('/api/me', editor.cookie)).statusCode).toBe(200);

    await send('PUT', `/api/teams/${TEAM_ID}/members/${editor.userId}`, harness.owner.cookie, { role: 'viewer' });
    // The cookie they held is refused on the very next request, on every route.
    expectFailure(await get('/api/me', editor.cookie), 401, 'UNAUTHENTICATED');
    expectFailure(await get(`/api/sites/${SITE_ID}`, editor.cookie), 401, 'UNAUTHENTICATED');

    harness.setNow(harness.now() + 61_000);
    const again = await harness.signIn('editor@test.example', PASSWORD);
    expect(await scopesOn(SITE_ID, again)).toEqual(['read:stats']);
  });

  it('ends them for a removal and for the identity flag taken away, and not for a raise', async () => {
    const reader = await member('reader@test.example', 'viewer', true);
    const viewer = await member('viewer@test.example', 'viewer');
    const leaver = await member('leaver@test.example', 'editor');
    const base = `/api/teams/${TEAM_ID}/members`;

    await send('PUT', `${base}/${reader.userId}`, harness.owner.cookie, { role: 'viewer', identity: false });
    expectFailure(await get('/api/me', reader.cookie), 401, 'UNAUTHENTICATED');

    await send('DELETE', `${base}/${leaver.userId}`, harness.owner.cookie);
    expectFailure(await get('/api/me', leaver.cookie), 401, 'UNAUTHENTICATED');

    const raised = await send('PUT', `${base}/${viewer.userId}`, harness.owner.cookie, { role: 'editor' });
    expect(envelope<unknown>(raised.body).meta).toMatchObject({ sessionsEnded: false });
    expect(await scopesOn(SITE_ID, viewer.cookie)).toEqual(['read:stats', 'write:events']);
  });

  it("ends them when a row on one site is lowered or removed, by what the person could do there", async () => {
    const visitor = await guest('guest@test.example');
    const second = await member('second@test.example', 'owner');
    const url = (userId: string): string => `/api/sites/${SITE_ID}/members/${userId}`;
    await send('PUT', url(visitor.userId), harness.owner.cookie, { role: 'editor' });
    expect(await scopesOn(SITE_ID, visitor.cookie)).toEqual(['read:stats', 'write:events']);

    await send('PUT', url(visitor.userId), harness.owner.cookie, { role: 'viewer' });
    expectFailure(await get(`/api/sites/${SITE_ID}`, visitor.cookie), 401, 'UNAUTHENTICATED');

    // A row an owner of the team holds decides nothing, so changing it lowers
    // nobody and ends nothing.
    await send('PUT', url(second.userId), harness.owner.cookie, { role: 'viewer' });
    await send('DELETE', url(second.userId), harness.owner.cookie);
    expect(await scopesOn(SITE_ID, second.cookie)).toEqual(OWNER_SCOPES);
  });

  it('refuses a cookie issued under an older count even though its signature is good', async () => {
    const editor = await member('editor@test.example', 'editor');
    await harness.store.bumpSessionEpoch(editor.userId);
    expectFailure(await get('/api/me', editor.cookie), 401, 'UNAUTHENTICATED');
    // Nobody else's count moved.
    expect((await get('/api/me', harness.owner.cookie)).statusCode).toBe(200);
  });
});

describe('the keys somebody made, when they stop being an admin', () => {
  async function ownerWithKey(): Promise<Person & { keyId: string; token: string }> {
    const second = await member('second@test.example', 'owner');
    const minted = await harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/keys`,
      headers: { cookie: second.cookie },
      payload: { name: 'Deploy pipeline', scopes: ['admin', 'write:events'] },
    });
    const body = envelope<{ key: { id: string }; once: { token: string } }>(minted.body).data;
    return { ...second, keyId: body?.key.id ?? '', token: `Bearer ${body?.once.token}` };
  }

  it('refuses the change until somebody says what to do with them, and says which keys', async () => {
    const second = await ownerWithKey();
    const url = `/api/teams/${TEAM_ID}/members/${second.userId}`;
    for (const response of [
      await send('PUT', url, harness.owner.cookie, { role: 'viewer' }),
      await send('DELETE', url, harness.owner.cookie),
    ]) {
      expectFailure(response, 409, 'KEYS_DECISION_REQUIRED');
      const details = (envelope<unknown>(response.body).error as { details?: { keys: unknown[] } }).details;
      expect(details?.keys).toEqual([
        { id: second.keyId, name: 'Deploy pipeline', siteId: SITE_ID, scopes: ['admin', 'write:events'] },
      ]);
      // Never the token, and never its hash.
      expect(response.body).not.toContain('chk_');
      expect(response.body).not.toContain('keyHash');
    }
    // Nothing happened: still an owner, still signed in, the key still works.
    expect(await scopesOn(SITE_ID, second.cookie)).toEqual(OWNER_SCOPES);
    expect(
      (await harness.app.inject({ method: 'GET', url: `/api/sites/${SITE_ID}/keys`, headers: { authorization: second.token } }))
        .statusCode,
    ).toBe(200);
  });

  it('revokes them when told to, and the key stops working', async () => {
    const second = await ownerWithKey();
    const changed = await send('PUT', `/api/teams/${TEAM_ID}/members/${second.userId}`, harness.owner.cookie, {
      role: 'viewer',
      revokeKeys: true,
    });
    expect(changed.statusCode).toBe(200);
    expect(envelope<unknown>(changed.body).meta).toMatchObject({
      sessionsEnded: true,
      keysRevoked: [{ id: second.keyId, name: 'Deploy pipeline', siteId: SITE_ID }],
      keysKept: [],
    });
    expectFailure(
      await harness.app.inject({ method: 'GET', url: `/api/sites/${SITE_ID}/keys`, headers: { authorization: second.token } }),
      401,
      'UNAUTHENTICATED',
    );
    const row = (await harness.store.auditPage({ scope: { kind: 'team', id: TEAM_ID }, limit: 1 })).rows[0];
    expect(row?.fields).toEqual(['role: owner > viewer', 'sessions ended', 'keys revoked: 1']);
  });

  it('keeps them when told to, and writes down which ones were kept', async () => {
    const second = await ownerWithKey();
    const removed = await send(
      'DELETE',
      `/api/teams/${TEAM_ID}/members/${second.userId}?revokeKeys=false`,
      harness.owner.cookie,
    );
    expect(removed.statusCode).toBe(200);
    expect(envelope<unknown>(removed.body).meta).toMatchObject({ keysRevoked: [], keysKept: [{ id: second.keyId }] });
    expect(
      (await harness.app.inject({ method: 'GET', url: `/api/sites/${SITE_ID}/keys`, headers: { authorization: second.token } }))
        .statusCode,
    ).toBe(200);
    const row = (await harness.store.auditPage({ scope: { kind: 'team', id: TEAM_ID }, limit: 1 })).rows[0];
    expect(row?.fields).toEqual([
      'role: owner > none',
      'sessions ended',
      'keys kept: 1',
      `key ${second.keyId} "Deploy pipeline" on ${SITE_ID}`,
    ]);
    expect(JSON.stringify(row)).not.toContain('chk_');
  });

  it('tells the last owner they are the last before it asks about their keys', async () => {
    const minted = await harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/keys`,
      headers: { cookie: harness.owner.cookie },
      payload: { name: 'Mine', scopes: ['admin'] },
    });
    expect(minted.statusCode).toBe(201);
    // The only owner, with a key of their own: the answer is that they cannot
    // step down, not a question about a change that will not happen.
    expectFailure(
      await send('PUT', `/api/teams/${TEAM_ID}/members/${harness.owner.userId}`, harness.owner.cookie, {
        role: 'viewer',
      }),
      409,
      'LAST_OWNER',
    );
  });

  it('asks nothing when the person keeps admin on the site the key is on', async () => {
    const second = await ownerWithKey();
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: second.userId, role: 'owner', identity: true });
    // Lowered in the team, but still an owner of this one site by its own row.
    const changed = await send('PUT', `/api/teams/${TEAM_ID}/members/${second.userId}`, harness.owner.cookie, {
      role: 'viewer',
    });
    expect(changed.statusCode).toBe(200);
    // And asked when that row is what goes.
    expectFailure(
      await send('DELETE', `/api/sites/${SITE_ID}/members/${second.userId}`, harness.owner.cookie),
      409,
      'KEYS_DECISION_REQUIRED',
    );
  });
});

describe('the invitations somebody sent, when they could no longer send them', () => {
  function invitation(id: string, invitedBy: string, scope: StoredInvitation['scope']): StoredInvitation {
    return {
      id,
      tokenHash: `hash-${id}`,
      email: `${id}@test.example`,
      scope,
      role: 'viewer',
      identity: false,
      invitedBy,
      createdAt: harness.now(),
      expiresAt: harness.now() + 86_400_000,
    };
  }

  it('are revoked with the change, and the ones they may still send are left', async () => {
    const second = await member('second@test.example', 'owner');
    await harness.store.setSiteMember({ siteId: SIBLING, userId: second.userId, role: 'owner', identity: true });
    await harness.store.createInvitation(invitation('inv_team', second.userId, { kind: 'team', id: TEAM_ID }));
    await harness.store.createInvitation(invitation('inv_site', second.userId, { kind: 'site', id: SITE_ID }));
    await harness.store.createInvitation(invitation('inv_kept', second.userId, { kind: 'site', id: SIBLING }));
    await harness.store.createInvitation(
      invitation('inv_other', harness.owner.userId, { kind: 'team', id: TEAM_ID }),
    );

    const changed = await send('PUT', `/api/teams/${TEAM_ID}/members/${second.userId}`, harness.owner.cookie, {
      role: 'viewer',
    });
    expect(envelope<unknown>(changed.body).meta).toMatchObject({ invitationsRevoked: 2 });

    expect((await harness.store.invitation('inv_team'))?.revokedBy).toBe(harness.owner.userId);
    expect((await harness.store.invitation('inv_site'))?.revokedAt).toBe(harness.now());
    // Still an owner of the sibling site by its own row, so that one stands.
    expect((await harness.store.invitation('inv_kept'))?.revokedAt).toBeUndefined();
    // And somebody else's invitation is nobody's to revoke here.
    expect((await harness.store.invitation('inv_other'))?.revokedAt).toBeUndefined();
  });
});

describe('an account another application signs in', () => {
  const STAFF = 'sso_staff_9';
  // The secret vitest.config.ts puts in the environment for this package: a
  // placeholder, never a real key.
  const SECRET = 'test-sso-secret-not-a-real-key-000000';
  let staffCookie: string;

  // Arrived the way such an account does: through the exchange, as a viewer.
  beforeEach(async () => {
    const arrived = await harness.app.inject({
      method: 'POST',
      url: '/api/sso',
      payload: {
        token: signHs256(
          SECRET,
          ssoClaimsFor({
            sub: 'staff_9',
            email: 'staff@test.example',
            teamId: TEAM_ID,
            role: 'viewer',
            now: harness.now(),
            lifetimeSeconds: 300,
          }),
        ),
      },
    });
    expect(arrived.statusCode).toBe(200);
    staffCookie = `${arrived.cookies[0]?.name}=${arrived.cookies[0]?.value}`;
  });

  it('is shown as managed there, and is not given a role, a site or a removal from here', async () => {
    const list = await get(`/api/teams/${TEAM_ID}/members`, harness.owner.cookie);
    const staff = envelope<{ members: { userId: string; managed: boolean }[] }>(list.body).data?.members.find(
      (row) => row.userId === STAFF,
    );
    expect(staff?.managed).toBe(true);

    for (const response of [
      await send('PUT', `/api/teams/${TEAM_ID}/members/${STAFF}`, harness.owner.cookie, { role: 'owner' }),
      await send('DELETE', `/api/teams/${TEAM_ID}/members/${STAFF}`, harness.owner.cookie),
      await send('PUT', `/api/sites/${SITE_ID}/members/${STAFF}`, harness.owner.cookie, { role: 'editor' }),
    ]) {
      expectFailure(response, 409, 'MANAGED_BY_SSO');
    }
    expect((await harness.store.team(TEAM_ID))?.members.find((row) => row.userId === STAFF)).toEqual({
      userId: STAFF,
      role: 'viewer',
      identity: false,
    });
    expect(await harness.store.siteGrantsForUser(STAFF)).toEqual([]);
  });

  it('gets nothing from a row on a site even if one is there', async () => {
    // Written past the routes, as nothing in the product can: the session
    // still reads only what the other application gave it.
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: STAFF, role: 'owner', identity: true });
    expect(await scopesOn(SITE_ID, staffCookie)).toEqual(['read:stats']);
  });
});

// No path that can lower or remove a member may reach the unguarded write.
// After this ticket nothing in the server or the paid half calls it at all:
// the first owner at registration and the first member of a team the exchange
// has just made both go through changeTeamMember, where adding somebody can
// lower nobody. This case is what fails when a new caller appears.
describe('setTeamMember, the write with no rule', () => {
  const ALLOWED: readonly string[] = [
    // The adapter that implements it.
    'packages/server/src/store/memory.store.ts',
  ];

  function sources(dir: string, into: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'dist') sources(path, into);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.test-utils\.ts$/.test(name)) {
        into.push(path);
      }
    }
    return into;
  }

  it('has no caller in the server or in packages/ee', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const callers: string[] = [];
    for (const start of ['packages/server/src', 'packages/ee/src']) {
      let files: string[] = [];
      try {
        files = sources(join(root, start));
      } catch {
        // packages/ee is not there on a core-only checkout, which is a
        // complete product and has nothing to scan.
        files = [];
      }
      for (const file of files) {
        if (/\bsetTeamMember\s*\(/.test(readFileSync(file, 'utf8'))) {
          callers.push(relative(root, file).split('\\').join('/'));
        }
      }
    }
    expect(callers.sort()).toEqual([...ALLOWED].sort());
  });
});
