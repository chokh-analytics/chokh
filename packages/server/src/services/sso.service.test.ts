import { describe, expect, it } from 'vitest';

import { exchangeSsoToken, ssoClaimsFor, type SsoDeps } from './sso.service.js';
import { signHs256 } from '../lib/jwt.js';
import { createMemoryOnce } from './once.js';
import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';
import { DEFAULT_TEAM_ID } from '../store/AnalyticsStore.js';

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
