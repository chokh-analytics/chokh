import { randomUUID } from 'node:crypto';

import { verifyHs256 } from '../lib/jwt.js';
import type { Refusal } from '../lib/store-error.js';
import {
  DEFAULT_TEAM_ID,
  ROLES,
  type AccountStore,
  type Role,
  type StoredUser,
} from '../store/AnalyticsStore.js';
import type { OnceOnly } from './once.js';

// The single sign-on exchange: a short lived token another application signed
// becomes a dashboard session here.
//
// The other application and this one share a secret. It signs a five minute
// HS256 token naming the person, hands it to their browser, and the browser
// arrives here; this verifies it, provisions the account if it has never seen it,
// and sets the session cookie. That is how a staff member clicks "open the full
// dashboard" in their own admin panel and is simply already signed in.
//
// Three things keep a five minute token from being a five minute password. The
// signature has to be ours (lib/jwt.ts refuses an algorithm it was not asked
// for). The lifetime has to be short, and a token claiming a longer one is
// refused however well it is signed. And the jti is single use, so a token read
// out of a URL, a proxy log or a browser history cannot be presented twice.

export interface SsoClaims {
  // The stable id of the person in the other application. Their account here is
  // keyed on it, so renaming or re-addressing them there does not make a second
  // account here.
  sub: string;
  email: string;
  name?: string;
  teamId: string;
  role: Role;
  identity: boolean;
  jti: string;
  exp: number;
}

export interface SsoDeps {
  store: AccountStore;
  once: OnceOnly;
  secret: string | undefined;
  maxAgeSeconds: number;
  now(): number;
}

export type SsoOutcome = { ok: true; user: StoredUser } | ({ ok: false } & Refusal);

function refuse(status: number, code: string, message: string): SsoOutcome {
  return { ok: false, status, code, message };
}

function readString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readRole(claims: Record<string, unknown>): Role | undefined {
  const value = claims['role'];
  if (value === undefined) {
    // Nothing said means the smallest thing: read the numbers, nothing else.
    return 'viewer';
  }
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
    ? (value as Role)
    : undefined;
}

// Who the person named by the token is here. Created on first arrival, which is
// what "just in time provisioning" means: an install never has to mirror the
// other application's user list.
//
// The account has no password. Somebody who arrived by SSO cannot sign in with
// one until they set one, which is right: their password lives in the other
// application and this one should not be a second place to guess it.
async function provision(
  deps: SsoDeps,
  claims: SsoClaims,
): Promise<StoredUser> {
  const userId = `sso_${claims.sub}`;
  const existing = await deps.store.userById(userId);
  if (existing !== null) {
    // The other application is the authority on their name, so a rename there
    // shows up here on their next visit.
    if (claims.name !== undefined && claims.name !== existing.name) {
      await deps.store.updateUser(userId, { name: claims.name });
    }
    return { ...existing, ...(claims.name === undefined ? {} : { name: claims.name }) };
  }
  const user: StoredUser = {
    id: userId,
    email: claims.email,
    createdAt: deps.now(),
    ...(claims.name === undefined ? {} : { name: claims.name }),
  };
  await deps.store.createUser(user);
  return user;
}

// The team the token names has to exist, or the person would arrive with a
// membership of nothing and see an empty site list. An install whose admin panel
// is the only way in never creates a team by hand, so the first arrival makes it.
async function ensureTeam(deps: SsoDeps, teamId: string): Promise<void> {
  if ((await deps.store.team(teamId)) === null) {
    await deps.store.createTeam({ id: teamId, name: teamId, members: [] });
  }
}

export async function exchangeSsoToken(deps: SsoDeps, token: string): Promise<SsoOutcome> {
  if (deps.secret === undefined) {
    return refuse(
      403,
      'SSO_NOT_CONFIGURED',
      'This install has no SSO secret, so no token can be exchanged',
    );
  }

  const verified = verifyHs256(token, deps.secret, deps.now(), deps.maxAgeSeconds);
  if (!verified.ok) {
    return refuse(401, verified.code, verified.message);
  }

  const sub = readString(verified.claims, 'sub');
  const email = readString(verified.claims, 'email');
  const jti = readString(verified.claims, 'jti');
  const role = readRole(verified.claims);
  if (sub === undefined || email === undefined || jti === undefined || role === undefined) {
    return refuse(
      401,
      'INCOMPLETE_CLAIMS',
      'A token needs sub, email, jti and, if it names one, a role of owner, editor or viewer',
    );
  }

  // Claimed before anything is written, so a token replayed twice in the same
  // instant cannot provision twice either. The claim is held for the rest of the
  // token's life, not longer: after that the token is refused on its own expiry.
  const remainingMs = Math.max(1000, verified.claims['exp'] as number * 1000 - deps.now());
  if (!(await deps.once.claim(`sso:${jti}`, remainingMs))) {
    return refuse(401, 'TOKEN_ALREADY_USED', 'That token has already been exchanged');
  }

  const claims: SsoClaims = {
    sub,
    email,
    teamId: readString(verified.claims, 'teamId') ?? DEFAULT_TEAM_ID,
    role,
    identity: verified.claims['identity'] === true,
    jti,
    exp: verified.claims['exp'] as number,
    ...(readString(verified.claims, 'name') === undefined
      ? {}
      : { name: readString(verified.claims, 'name') as string }),
  };

  const user = await provision(deps, claims);
  await ensureTeam(deps, claims.teamId);
  await deps.store.setTeamMember(claims.teamId, {
    userId: user.id,
    role: claims.role,
    identity: claims.identity,
  });
  return { ok: true, user };
}

// What an application signs, for the README and for the tests. Not exported as a
// signer: this package verifies, and @chokh/sdk-node is where an application
// gets the one line that makes one.
export function ssoClaimsFor(input: {
  sub: string;
  email: string;
  name?: string;
  teamId?: string;
  role?: Role;
  identity?: boolean;
  now: number;
  lifetimeSeconds: number;
}): Record<string, unknown> {
  const issued = Math.floor(input.now / 1000);
  return {
    sub: input.sub,
    email: input.email,
    ...(input.name === undefined ? {} : { name: input.name }),
    teamId: input.teamId ?? DEFAULT_TEAM_ID,
    role: input.role ?? 'viewer',
    identity: input.identity ?? false,
    jti: randomUUID(),
    iat: issued,
    exp: issued + input.lifetimeSeconds,
  };
}
