import { randomUUID } from 'node:crypto';

import { verifyHs256 } from '../lib/jwt.js';
import { attempt, type Refusal } from '../lib/store-error.js';
import {
  DEFAULT_TEAM_ID,
  ROLES,
  type AccountStore,
  type AnalyticsStore,
  type AuditRecord,
  type Role,
  type StoredUser,
} from '../store/AnalyticsStore.js';
import { recordAccessChange } from './audit.service.js';
import { changeTeamMembership } from './members.service.js';
import type { OnceOnly } from './once.js';
import { ssoAccountId } from './sso-accounts.js';

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
//
// The exchange is also a grant: the token says what the person is in a team,
// and that is what they are from this arrival on. It is held to the same rule
// as a change made by hand (AN-TEAM01): a team keeps an owner, and keeps one
// with a password where it had one. A token that would break that is refused
// outright. It does not sign the person in with the role they had, because
// then the token's word would have been ignored in silence; it signs nobody
// in, changes nothing, and writes a row an owner can read.

export const SSO_ROUTE = 'SSO exchange';

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
  store: AnalyticsStore & AccountStore;
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

// The team the token names has to exist, or the person would arrive with a
// membership of nothing and see an empty site list. An install whose admin panel
// is the only way in never creates a team by hand, so the first arrival makes it.
// It is made empty: its first member is added below like any other, and a team
// with no owner yet has nothing for the last-owner rule to protect.
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

  const name = readString(verified.claims, 'name');
  const claims: SsoClaims = {
    sub,
    email,
    teamId: readString(verified.claims, 'teamId') ?? DEFAULT_TEAM_ID,
    role,
    identity: verified.claims['identity'] === true,
    jti,
    exp: verified.claims['exp'] as number,
    ...(name === undefined ? {} : { name }),
  };

  // Who the person named by the token is here. Created on first arrival, which
  // is what "just in time provisioning" means: an install never has to mirror
  // the other application's user list. The account has no password: theirs
  // lives in the other application, and this should not be a second place to
  // guess it.
  const userId = ssoAccountId(claims.sub);
  const existing = await deps.store.userById(userId);
  if (existing === null) {
    await deps.store.createUser({
      id: userId,
      email: claims.email,
      createdAt: deps.now(),
      ...(claims.name === undefined ? {} : { name: claims.name }),
    });
  }
  await ensureTeam(deps, claims.teamId);

  // The membership, only when the token says something different from what is
  // there. An arrival that changes nothing writes nothing and ends no session.
  const team = await deps.store.team(claims.teamId);
  const held = team?.members.find((member) => member.userId === userId);
  const actor: AuditRecord['actor'] = { kind: 'sso', id: userId, email: claims.email };
  if (held === undefined || held.role !== claims.role || held.identity !== claims.identity) {
    const changed = await changeTeamMembership(deps, {
      teamId: claims.teamId,
      userId,
      to: { role: claims.role, identity: claims.identity },
      actor,
      route: SSO_ROUTE,
      // Nobody is here to be asked, so the keys this person made are kept, and
      // the audit row names them so an owner can decide.
      keys: 'keep',
    });
    if (!changed.ok) {
      // The last owner of the team, or its last owner with a password, and a
      // token that would lower them. Nothing was changed above (the store
      // refuses before it writes), and nobody is signed in.
      await recordAccessChange(deps.store, {
        scope: { kind: 'team', id: claims.teamId },
        actor,
        action: 'member:refused',
        route: SSO_ROUTE,
        target: userId,
        fields: [
          `role: ${held?.role ?? 'none'} > ${claims.role}`,
          `refused: ${changed.code}`,
        ],
        at: deps.now(),
      });
      return refuse(changed.status, changed.code, changed.message);
    }
  }

  // The other application is the authority on their name, so a rename there
  // shows up here on their next visit. After the membership, so a refused
  // arrival changes nothing at all.
  if (existing !== null && claims.name !== undefined && claims.name !== existing.name) {
    const renamed = await attempt(() => deps.store.updateUser(userId, { name: claims.name as string }));
    if (!renamed.ok) {
      return refuse(renamed.status, renamed.code, renamed.message);
    }
  }

  // Read again, after everything: if the change lowered them, the count that
  // ends their sessions has moved, and the cookie about to be made has to be
  // made under the new one or it would be dead on arrival.
  const user = await deps.store.userById(userId);
  if (user === null) {
    return refuse(500, 'INTERNAL_ERROR', 'The account could not be read back');
  }
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
