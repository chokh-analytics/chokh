import { describe, expect, it } from 'vitest';

import {
  authenticate,
  bearerToken,
  createSessionCodec,
  hashPassword,
  resolvePrincipal,
  verifyPassword,
  type AuthDeps,
} from './auth.service.js';
import { createApiKey } from './keys.service.js';
import { createMemoryStore } from '../store/memory.store.js';
import { defaultSiteSettings, type Site } from '../store/AnalyticsStore.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const PASSWORD = 'a-password-long-enough';

function site(): Site {
  return {
    id: 's_one',
    name: 'One',
    domains: ['one.example'],
    teamId: 't_one',
    settings: defaultSiteSettings(),
  };
}

async function deps(): Promise<AuthDeps & { store: ReturnType<typeof createMemoryStore> }> {
  const store = createMemoryStore([], { now: () => NOW });
  await store.createSite(site());
  await store.createUser({
    id: 'u_1',
    email: 'one@example.com',
    passwordHash: await hashPassword(PASSWORD),
    createdAt: NOW,
  });
  await store.createTeam({
    id: 't_one',
    name: 'One',
    members: [{ userId: 'u_1', role: 'owner', identity: true }],
  });
  return {
    store,
    session: createSessionCodec('a-session-secret-not-a-real-key-00', 12 * HOUR),
    now: () => NOW,
  };
}

describe('password hashing', () => {
  it('is argon2id, and a hash verifies only against its own password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, 'the-wrong-password')).toBe(false);
  });

  it('salts, so the same password twice is two hashes', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  // Without the decoy hash, a missing account costs nothing and a real one costs
  // tens of milliseconds, which is an account enumeration oracle.
  it('still does the work when there is no hash to check against', async () => {
    const started = process.hrtime.bigint();
    expect(await verifyPassword(undefined, PASSWORD)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(elapsedMs).toBeGreaterThan(1);
  });

  it('answers false rather than throwing on a hash it cannot read', async () => {
    expect(await verifyPassword('not-a-hash-at-all', PASSWORD)).toBe(false);
  });
});

describe('the session cookie', () => {
  const codec = createSessionCodec('a-session-secret-not-a-real-key-00', 12 * HOUR);

  it('reads back the account it was issued for', () => {
    const issued = codec.issue('u_1', NOW);
    expect(codec.read(issued.value, NOW)).toBe('u_1');
    expect(issued.expiresAt).toBe(NOW + 12 * HOUR);
  });

  it('refuses a cookie whose payload was edited', () => {
    const issued = codec.issue('u_1', NOW);
    const [, signature] = issued.value.split('.') as [string, string];
    const forged = `${Buffer.from(JSON.stringify({ uid: 'u_admin', exp: NOW + HOUR })).toString('base64url')}.${signature}`;
    expect(codec.read(forged, NOW)).toBeNull();
  });

  it('refuses a cookie signed with another secret', () => {
    const other = createSessionCodec('a-completely-different-secret-0000', 12 * HOUR);
    expect(codec.read(other.issue('u_1', NOW).value, NOW)).toBeNull();
  });

  it('refuses one that has run out', () => {
    const issued = codec.issue('u_1', NOW);
    expect(codec.read(issued.value, NOW + 12 * HOUR + 1)).toBeNull();
  });

  it('refuses nonsense and nothing', () => {
    expect(codec.read(undefined, NOW)).toBeNull();
    expect(codec.read('', NOW)).toBeNull();
    expect(codec.read('nodot', NOW)).toBeNull();
    expect(codec.read('.sig', NOW)).toBeNull();
  });
});

describe('bearerToken', () => {
  it('reads a token out of an Authorization header, whatever its case', () => {
    expect(bearerToken('Bearer chk_one')).toBe('chk_one');
    expect(bearerToken('bearer chk_one')).toBe('chk_one');
    expect(bearerToken('Bearer   chk_one  ')).toBe('chk_one');
  });

  it('answers nothing for anything else', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
  });
});

describe('resolvePrincipal', () => {
  it('is the account the cookie names, with the teams they are in', async () => {
    const context = await deps();
    const cookie = context.session.issue('u_1', NOW).value;
    const principal = await resolvePrincipal(context, { cookie, authorization: undefined });
    expect(principal?.kind).toBe('session');
    expect(principal?.email).toBe('one@example.com');
    expect(principal?.grantFor(site())?.role).toBe('owner');
  });

  it('is the key a bearer token names, with the scopes it was minted with', async () => {
    const context = await deps();
    const minted = await createApiKey(context.store, {
      siteId: 's_one',
      name: 'reader',
      scopes: ['read:stats'],
      createdBy: 'u_1',
      now: NOW,
    });
    const principal = await resolvePrincipal(context, {
      cookie: undefined,
      authorization: `Bearer ${minted.token}`,
    });
    expect(principal?.kind).toBe('key');
    expect([...(principal?.grantFor(site())?.scopes ?? [])]).toEqual(['read:stats']);
  });

  // A request that presents a key is a program saying which identity it wants used.
  // Falling back to whatever cookie the browser sent is the confused deputy.
  it('prefers a key over a cookie, and refuses a bad key rather than falling back', async () => {
    const context = await deps();
    const cookie = context.session.issue('u_1', NOW).value;
    const principal = await resolvePrincipal(context, {
      cookie,
      authorization: 'Bearer chk_not_a_real_key',
    });
    expect(principal).toBeNull();
  });

  it('is nobody with no credentials', async () => {
    const context = await deps();
    expect(await resolvePrincipal(context, { cookie: undefined, authorization: undefined })).toBeNull();
  });

  // Read fresh on every request, which is what makes removing somebody from a team
  // take effect on their next request rather than when their cookie runs out.
  it('is nobody when the account behind a valid cookie has gone', async () => {
    const context = await deps();
    const cookie = context.session.issue('u_gone', NOW).value;
    expect(await resolvePrincipal(context, { cookie, authorization: undefined })).toBeNull();
  });

  it('sees a membership change without a new cookie', async () => {
    const context = await deps();
    const cookie = context.session.issue('u_1', NOW).value;
    await context.store.setTeamMember('t_one', { userId: 'u_1', role: 'viewer', identity: false });
    const principal = await resolvePrincipal(context, { cookie, authorization: undefined });
    expect(principal?.grantFor(site())?.role).toBe('viewer');
    expect(principal?.grantFor(site())?.scopes.has('admin')).toBe(false);
  });
});

describe('authenticate', () => {
  it('answers with the account and stamps the sign-in', async () => {
    const context = await deps();
    const user = await authenticate(context, 'one@example.com', PASSWORD);
    expect(user?.id).toBe('u_1');
    expect((await context.store.userById('u_1'))?.lastLoginAt).toBe(NOW);
  });

  it('answers null for the wrong password and for an address nobody uses', async () => {
    const context = await deps();
    expect(await authenticate(context, 'one@example.com', 'wrong-password-here')).toBeNull();
    expect(await authenticate(context, 'nobody@example.com', PASSWORD)).toBeNull();
  });

  // Somebody the SSO exchange created has no password, so nobody can sign in as them
  // with one until they set it.
  it('refuses an account with no password at all', async () => {
    const context = await deps();
    await context.store.createUser({ id: 'u_sso', email: 'sso@example.com', createdAt: NOW });
    expect(await authenticate(context, 'sso@example.com', PASSWORD)).toBeNull();
    expect(await authenticate(context, 'sso@example.com', '')).toBeNull();
  });
});
