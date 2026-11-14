import { describe, expect, it } from 'vitest';

import { exchangeSsoToken, ssoClaimsFor, type SsoDeps } from './sso.service.js';
import { signHs256 } from '../lib/jwt.js';
import { createMemoryOnce } from './once.js';
import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';
import { DEFAULT_TEAM_ID, defaultSiteSettings } from '../store/AnalyticsStore.js';

// A placeholder, never a real key: no secret belongs in this repository.
const SECRET = 'test-sso-secret-not-a-real-key-000000';
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

function open(overrides: Partial<SsoDeps> = {}): SsoDeps & { store: MemoryStore } {
  const store = createMemoryStore([], { now: () => NOW });
  return {
    store,
    once: createMemoryOnce(() => NOW),
    secret: SECRET,
    maxAgeSeconds: 300,
    now: () => NOW,
    ...overrides,
  } as SsoDeps & { store: MemoryStore };
}

type ClaimInput = Parameters<typeof ssoClaimsFor>[0];

// A signed token, with the defaults an admin panel would use. `extra` overwrites a
// claim afterwards, which is how the cases about a malformed claim are written.
function token(
  input: Partial<ClaimInput> & { extra?: Record<string, unknown> } = {},
  secret = SECRET,
): string {
  const { extra, ...rest } = input;
  const claims: ClaimInput = {
    sub: 'staff_7',
    email: 'staff@example.com',
    name: 'Staff Seven',
    now: NOW,
    lifetimeSeconds: 300,
    ...rest,
  };
  return signHs256(secret, { ...ssoClaimsFor(claims), ...extra });
}

describe('exchangeSsoToken', () => {
  it('provisions an account on first arrival and gives it the membership the token names', async () => {
    const deps = open();
    const result = await exchangeSsoToken(deps, token({ role: 'editor', identity: true }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.email).toBe('staff@example.com');
    expect(result.user.name).toBe('Staff Seven');
    // No password: their password lives in the other application and this one
    // should not be a second place to guess it.
    expect(result.user.passwordHash).toBeUndefined();

    const team = await deps.store.team(DEFAULT_TEAM_ID);
    expect(team?.members).toEqual([
      { userId: result.user.id, role: 'editor', identity: true },
    ]);
  });

  it('finds the same account the second time rather than making another', async () => {
    const deps = open();
    const first = await exchangeSsoToken(deps, token());
    const second = await exchangeSsoToken(deps, token());
    expect(first.ok && second.ok && first.user.id === second.user.id).toBe(true);
    expect(await deps.store.userCount()).toBe(1);
  });

  it('takes a rename from the other application, which is the authority on it', async () => {
    const deps = open();
    await exchangeSsoToken(deps, token());
    const again = await exchangeSsoToken(deps, token({ name: 'Staff Renamed' }));
    expect(again.ok && again.user.name).toBe('Staff Renamed');
  });

  it('defaults to a viewer when the token names no role', async () => {
    const deps = open();
    const result = await exchangeSsoToken(deps, token());
    expect(result.ok).toBe(true);
    const team = await deps.store.team(DEFAULT_TEAM_ID);
    expect(team?.members[0]).toMatchObject({ role: 'viewer', identity: false });
  });

  it('creates the team the token names when nobody has', async () => {
    const deps = open();
    await exchangeSsoToken(deps, token({ teamId: 't_progsity', role: 'owner' }));
    const team = await deps.store.team('t_progsity');
    expect(team?.members[0]).toMatchObject({ role: 'owner' });
  });

  // The whole reason a token in a URL is acceptable: by the time it has been written
  // down anywhere it is already worth nothing.
  it('refuses a token that has already been exchanged', async () => {
    const deps = open();
    const one = token();
    expect((await exchangeSsoToken(deps, one)).ok).toBe(true);
    expect(await exchangeSsoToken(deps, one)).toMatchObject({
      ok: false,
      status: 401,
      code: 'TOKEN_ALREADY_USED',
    });
  });

  it('refuses a token signed with another secret', async () => {
    const deps = open();
    expect(
      await exchangeSsoToken(deps, token({}, 'a-completely-different-secret-00000')),
    ).toMatchObject({ code: 'BAD_SIGNATURE', status: 401 });
  });

  it('refuses a token that has run out', async () => {
    const deps = open({ now: () => NOW + 301_000 });
    expect(await exchangeSsoToken(deps, token())).toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('refuses a token claiming a longer life than the window allows', async () => {
    const deps = open();
    expect(await exchangeSsoToken(deps, token({ lifetimeSeconds: 86_400 }))).toMatchObject({
      code: 'TOKEN_TOO_LONG',
    });
  });

  it('refuses a token missing a claim it needs', async () => {
    const deps = open();
    const seconds = Math.floor(NOW / 1000);
    const withoutJti = signHs256(SECRET, {
      sub: 'staff_7',
      email: 'staff@example.com',
      iat: seconds,
      exp: seconds + 300,
    });
    expect(await exchangeSsoToken(deps, withoutJti)).toMatchObject({ code: 'INCOMPLETE_CLAIMS' });
  });

  it('refuses a role it does not know rather than falling back to one', async () => {
    const deps = open();
    const bad = token({ extra: { role: 'superuser' } });
    expect(await exchangeSsoToken(deps, bad)).toMatchObject({ code: 'INCOMPLETE_CLAIMS' });
  });

  // An SSO endpoint nobody configured is an open door, so the default is closed.
  it('refuses everything when the install has no SSO secret', async () => {
    const deps = open({ secret: undefined });
    expect(await exchangeSsoToken(deps, token())).toMatchObject({
      ok: false,
      status: 403,
      code: 'SSO_NOT_CONFIGURED',
    });
  });

  it('writes nothing when it refuses', async () => {
    const deps = open();
    await exchangeSsoToken(deps, token({}, 'a-completely-different-secret-00000'));
    expect(await deps.store.userCount()).toBe(0);
    expect(await deps.store.team(DEFAULT_TEAM_ID)).toBeNull();
  });
});

// The exchange is a grant, and it is held to the rule a change made by hand is
// held to (AN-TEAM01): a team keeps an owner, and keeps one with a password
// where it had one. Which of the two applies to a team the exchange made
// itself, of accounts that have no password anywhere: the first, alone. There
// is no owner with a password to keep, so the second has nothing to say; the
// last owner still cannot be lowered, by this door or any other.
describe('the exchange and the last owner of a team', () => {
  const TEAM = 't_made_here';

  async function arrive(
    deps: ReturnType<typeof open>,
    sub: string,
    role: 'owner' | 'editor' | 'viewer',
    extra: Partial<ClaimInput> = {},
  ): Promise<Awaited<ReturnType<typeof exchangeSsoToken>>> {
    return exchangeSsoToken(
      deps,
      token({ sub, email: `${sub}@example.com`, teamId: TEAM, role, identity: role === 'owner', ...extra }),
    );
  }

  function teamLog(deps: ReturnType<typeof open>) {
    return deps.store.auditPage({ scope: { kind: 'team', id: TEAM }, limit: 20 });
  }

  it('makes the team and adds its first member, and says so in the log of that team', async () => {
    const deps = open();
    const first = await arrive(deps, 'staff_1', 'owner');
    expect(first.ok).toBe(true);
    expect((await deps.store.team(TEAM))?.members).toEqual([
      { userId: 'sso_staff_1', role: 'owner', identity: true },
    ]);
    const log = await teamLog(deps);
    expect(log.rows.map((row) => [row.action, row.target, row.fields])).toEqual([
      ['member:set', 'sso_staff_1', ['role: none > owner']],
    ]);
    // Nobody clicked anything in this dashboard: the actor is the exchange.
    expect(log.rows[0]?.actor).toEqual({
      kind: 'sso',
      id: 'sso_staff_1',
      email: 'staff_1@example.com',
    });
  });

  it('refuses a token that would lower the last owner, signs nobody in and changes nothing', async () => {
    const deps = open();
    await arrive(deps, 'staff_1', 'owner');
    await arrive(deps, 'staff_2', 'viewer');

    const refused = await arrive(deps, 'staff_1', 'viewer', { name: 'A New Name' });
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'LAST_OWNER' });

    // The role they had is the role they have, their sessions were not ended,
    // and not even the name the token carried was taken.
    expect((await deps.store.team(TEAM))?.members).toEqual([
      { userId: 'sso_staff_1', role: 'owner', identity: true },
      { userId: 'sso_staff_2', role: 'viewer', identity: false },
    ]);
    const account = await deps.store.userById('sso_staff_1');
    expect(account?.sessionEpoch ?? 0).toBe(0);
    expect(account?.name).toBe('Staff Seven');
    // And an owner reading the log sees that it was asked and refused.
    const log = await teamLog(deps);
    expect(log.rows[0]).toMatchObject({
      action: 'member:refused',
      target: 'sso_staff_1',
      fields: ['role: owner > viewer', 'refused: LAST_OWNER'],
      actor: { kind: 'sso', id: 'sso_staff_1' },
    });
  });

  it('lowers an owner while another remains, and ends the sessions they had before the new one is made', async () => {
    const deps = open();
    await arrive(deps, 'staff_1', 'owner');
    await arrive(deps, 'staff_2', 'owner');

    const lowered = await arrive(deps, 'staff_1', 'viewer');
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    // The account handed back for the new cookie already carries the count
    // that killed the old ones.
    expect(lowered.user.sessionEpoch).toBe(1);
    expect((await deps.store.team(TEAM))?.members.find((row) => row.userId === 'sso_staff_1')?.role).toBe(
      'viewer',
    );
    expect((await teamLog(deps)).rows[0]?.fields).toEqual(['role: owner > viewer', 'sessions ended']);
    // The one who is left is now the last, and is held like any last owner.
    expect(await arrive(deps, 'staff_2', 'editor')).toMatchObject({ ok: false, code: 'LAST_OWNER' });
  });

  it('writes nothing and ends nothing when the token says what is already so', async () => {
    const deps = open();
    await arrive(deps, 'staff_1', 'owner');
    const again = await arrive(deps, 'staff_1', 'owner');
    expect(again.ok).toBe(true);
    expect((await teamLog(deps)).rows).toHaveLength(1);
    expect((await deps.store.userById('sso_staff_1'))?.sessionEpoch ?? 0).toBe(0);
  });

  it('raises somebody without ending their sessions', async () => {
    const deps = open();
    await arrive(deps, 'staff_1', 'owner');
    await arrive(deps, 'staff_2', 'viewer');
    const raised = await arrive(deps, 'staff_2', 'owner');
    expect(raised.ok && (raised.user.sessionEpoch ?? 0)).toBe(0);
    expect((await teamLog(deps)).rows[0]?.fields).toEqual(['role: viewer > owner']);
  });

  // The exchange cannot ask what to do about keys, so it keeps them, and the
  // row says how many and where so an owner can go and decide.
  it('keeps the keys a lowered owner made and names them in the log, never a token', async () => {
    const deps = open();
    await arrive(deps, 'staff_1', 'owner');
    await arrive(deps, 'staff_2', 'owner');
    await deps.store.createSite({
      id: 's_here',
      name: 'Here',
      domains: ['here.example'],
      teamId: TEAM,
      settings: defaultSiteSettings(),
    });
    await deps.store.createApiKey({
      id: 'k_deploy',
      siteId: 's_here',
      name: 'Deploy pipeline',
      keyHash: 'a-hash-that-must-not-be-written-anywhere',
      scopes: ['admin'],
      createdAt: NOW,
      createdBy: 'sso_staff_1',
    });

    expect((await arrive(deps, 'staff_1', 'viewer')).ok).toBe(true);
    expect((await deps.store.apiKeys('s_here')).map((key) => key.id)).toEqual(['k_deploy']);
    const row = (await teamLog(deps)).rows[0];
    expect(row?.fields).toEqual([
      'role: owner > viewer',
      'sessions ended',
      'keys kept: 1',
      'key k_deploy "Deploy pipeline" on s_here',
    ]);
    expect(JSON.stringify(row)).not.toContain('a-hash-that-must-not-be-written-anywhere');
  });

  it('revokes the invitations a lowered owner sent and could no longer send', async () => {
    const deps = open();
    await arrive(deps, 'staff_1', 'owner');
    await arrive(deps, 'staff_2', 'owner');
    await deps.store.createInvitation({
      id: 'inv_1',
      tokenHash: 'hash-inv_1',
      email: 'new@example.com',
      scope: { kind: 'team', id: TEAM },
      role: 'owner',
      identity: true,
      invitedBy: 'sso_staff_1',
      createdAt: NOW,
      expiresAt: NOW + 86_400_000,
    });
    await arrive(deps, 'staff_1', 'viewer');
    expect((await deps.store.invitation('inv_1'))?.revokedAt).toBe(NOW);
    expect((await teamLog(deps)).rows[0]?.fields).toContain('invitations revoked: 1');
  });

  // A team with somebody who can sign in with a password: the exchange may
  // lower one of its own beside them, and the second rule is not what stops
  // it, because the owner with a password is still there.
  it('lowers one of its own beside an owner who has a password', async () => {
    const deps = open();
    await deps.store.createUser({ id: 'u_local', email: 'local@example.com', passwordHash: 'h', createdAt: NOW });
    await deps.store.createTeam({
      id: TEAM,
      name: 'Mixed',
      members: [{ userId: 'u_local', role: 'owner', identity: true }],
    });
    await arrive(deps, 'staff_1', 'owner');
    expect((await arrive(deps, 'staff_1', 'viewer')).ok).toBe(true);
    expect((await deps.store.team(TEAM))?.members.map((row) => row.role)).toEqual(['owner', 'viewer']);
  });
});
