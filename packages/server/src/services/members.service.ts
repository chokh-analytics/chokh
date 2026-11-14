import { grantOn, roleRank, teamIdOf, type Grant } from '../lib/scopes.js';
import { attempt, type Refusal } from '../lib/store-error.js';
import { changedMembers } from '../store/AnalyticsStore.js';
import type {
  AccessScope,
  AccountStore,
  AnalyticsStore,
  ApiKeyRecord,
  AuditRecord,
  Role,
  Scope,
  Site,
  SiteMember,
  StoredTeam,
  TeamMember,
  TeamMemberChange,
} from '../store/AnalyticsStore.js';
import { recordAccessChange } from './audit.service.js';

// Changing who may reach a team or a site (AN-TEAM01).
//
// Every way a membership changes comes through here: the Team page's routes,
// the route a single site's owner uses, and the SSO exchange when a token says
// somebody's role is different now. That is the point of the file. A change
// made in one place and forgotten in another is how somebody stays signed in
// after they were removed, or keeps an invitation in flight that they could no
// longer send; so the four things that have to follow a change are done in one
// function and no caller gets to choose three of them.
//
// What follows a change, in this order:
//
// 1. The change itself, under the store's rule that a team keeps an owner and
//    keeps one with a password where it had one. Refused, nothing below runs.
// 2. If it lowered anybody, that account's sessions are ended: the count on
//    the account moves, and every cookie issued before it is refused on the
//    next request. Lowered means removed, a lower role, or the identity flag
//    gone; a raise ends nothing.
// 3. The invitations that account sent and could no longer send are revoked.
//    An invitation is never worth more than its sender.
// 4. The keys question. A key belongs to a site and not to its maker, so
//    somebody who minted an admin key and then loses admin still has admin
//    through the key. Nothing here decides that silently in either direction:
//    the caller says revoke or keep, and a caller who has not been asked yet is
//    refused with the list. The exchange cannot ask, so it keeps them and the
//    audit row says how many and where.
// 5. One audit row, about the team or the site, saying who did it, to whom,
//    and what changed.

export interface MembersDeps {
  store: AnalyticsStore & AccountStore;
  now(): number;
}

// What to do about the keys the person made on the sites they are losing
// admin on. `ask` refuses with the list when there are any.
export type KeysDecision = 'ask' | 'revoke' | 'keep';

export interface KeySummary {
  id: string;
  name: string;
  siteId: string;
  scopes: Scope[];
}

export interface MembershipChange {
  // Whether the account's sessions were ended.
  sessionsEnded: boolean;
  keysRevoked: KeySummary[];
  keysKept: KeySummary[];
  invitationsRevoked: number;
}

export type MembershipOutcome<T> =
  | ({ ok: true } & T & MembershipChange)
  | ({ ok: false; details?: unknown } & Refusal);

function summary(key: ApiKeyRecord): KeySummary {
  return { id: key.id, name: key.name, siteId: key.siteId, scopes: key.scopes };
}

// Everything one account holds: its place in each team and its rows on sites.
interface Holding {
  teams: StoredTeam[];
  rows: SiteMember[];
}

async function holdingOf(store: AccountStore, userId: string): Promise<Holding> {
  const [teams, rows] = await Promise.all([
    store.teamsForUser(userId),
    store.siteGrantsForUser(userId),
  ]);
  return { teams, rows };
}

function memberIn(holding: Holding, teamId: string, userId: string): TeamMember | undefined {
  return holding.teams
    .find((team) => team.id === teamId)
    ?.members.find((member) => member.userId === userId);
}

function grantWith(holding: Holding, site: Site, userId: string): Grant | null {
  return grantOn(
    memberIn(holding, teamIdOf(site), userId),
    holding.rows.find((row) => row.siteId === site.id),
  );
}

function lost(before: Grant | null, after: Grant | null): boolean {
  if (before === null) return false;
  if (after === null) return true;
  return [...before.scopes].some((scope) => !after.scopes.has(scope));
}

// A team role as what it lets somebody do, for telling a lowering from a
// raise when the team holds no site to compare grants on.
function standing(member: Pick<TeamMember, 'role' | 'identity'> | undefined): {
  rank: number;
  identity: boolean;
} {
  if (member === undefined) return { rank: 0, identity: false };
  return { rank: roleRank(member.role), identity: member.role === 'owner' || member.identity };
}

// A role as the log says it. An owner has identity by being one, so the flag
// is only worth saying for the two roles it changes anything for.
function said(role: Role | undefined, identity: boolean | undefined): string {
  if (role === undefined) return 'none';
  return role !== 'owner' && identity === true ? `${role}+identity` : role;
}

// Whether an account may still send an invitation it sent: to a team, only an
// owner of that team; to a site, only somebody with admin on it.
async function maySend(
  store: AnalyticsStore & AccountStore,
  holding: Holding,
  userId: string,
  scope: AccessScope,
): Promise<boolean> {
  if (scope.kind === 'team') {
    return memberIn(holding, scope.id, userId)?.role === 'owner';
  }
  const site = await store.site(scope.id);
  return site !== null && (grantWith(holding, site, userId)?.scopes.has('admin') ?? false);
}

// Revoke what an account sent and can no longer send. Run after the change,
// against what the account holds now.
async function revokeUnsendable(
  deps: MembersDeps,
  userId: string,
  by: string,
): Promise<number> {
  const sent = await deps.store.invitationsSentBy(userId);
  if (sent.length === 0) {
    return 0;
  }
  const holding = await holdingOf(deps.store, userId);
  let revoked = 0;
  for (const invitation of sent) {
    if (!(await maySend(deps.store, holding, userId, invitation.scope))) {
      if (await deps.store.revokeInvitation(invitation.id, deps.now(), by)) {
        revoked += 1;
      }
    }
  }
  return revoked;
}

// The keys an account made on the given sites.
async function keysMadeBy(
  store: AccountStore,
  userId: string,
  sites: readonly Site[],
): Promise<KeySummary[]> {
  const found: KeySummary[] = [];
  for (const site of sites) {
    for (const key of await store.apiKeys(site.id)) {
      if (key.createdBy === userId) {
        found.push(summary(key));
      }
    }
  }
  return found;
}

const KEYS_DECISION_REQUIRED =
  'This person made keys on a site they are losing admin on. Say whether to revoke them (revokeKeys: true) or keep them (revokeKeys: false)';

interface Follow {
  deps: MembersDeps;
  userId: string;
  actor: AuditRecord['actor'];
  scope: AccessScope;
  action: string;
  route: string;
  lowered: boolean;
  keys: KeySummary[];
  decision: KeysDecision;
  // What changed, for the audit row: the role before and after.
  changed: string[];
}

// Steps 2 to 5, the same for a team and for a site.
async function follow(input: Follow): Promise<MembershipChange> {
  const { deps, userId, actor } = input;
  if (input.lowered) {
    await deps.store.bumpSessionEpoch(userId);
  }
  const invitationsRevoked = await revokeUnsendable(deps, userId, actor.id);

  const keysRevoked: KeySummary[] = [];
  const keysKept: KeySummary[] = [];
  for (const key of input.keys) {
    if (input.decision === 'revoke' && (await deps.store.deleteApiKey(key.siteId, key.id))) {
      keysRevoked.push(key);
    } else {
      keysKept.push(key);
    }
  }

  const fields = [...input.changed];
  if (input.lowered) fields.push('sessions ended');
  if (invitationsRevoked > 0) fields.push(`invitations revoked: ${invitationsRevoked}`);
  if (keysRevoked.length > 0) fields.push(`keys revoked: ${keysRevoked.length}`);
  if (keysKept.length > 0) {
    fields.push(`keys kept: ${keysKept.length}`);
    // Which ones, so an owner reading the log can go and look: the id, the
    // name and the site, never a token (only its hash is stored anyway).
    for (const key of keysKept) {
      fields.push(`key ${key.id} "${key.name}" on ${key.siteId}`);
    }
  }
  await recordAccessChange(deps.store, {
    scope: input.scope,
    actor,
    action: input.action,
    route: input.route,
    target: userId,
    fields,
    at: deps.now(),
  });
  return { sessionsEnded: input.lowered, keysRevoked, keysKept, invitationsRevoked };
}

export interface TeamChangeInput {
  teamId: string;
  userId: string;
  // Null takes the member out.
  to: TeamMemberChange | null;
  actor: AuditRecord['actor'];
  route: string;
  keys: KeysDecision;
}

// Change one member of a team, add one, or take one out.
export async function changeTeamMembership(
  deps: MembersDeps,
  input: TeamChangeInput,
): Promise<MembershipOutcome<{ team: StoredTeam }>> {
  const { store } = deps;
  const { teamId, userId, to } = input;

  const before = await holdingOf(store, userId);
  const was = memberIn(before, teamId, userId);

  // The last-owner rule, looked at before anything is asked. The store checks
  // it again as it writes, and that check is the rule; this one is so that
  // somebody who cannot be lowered at all is told that, and is not first asked
  // what to do with keys for a change that was never going to happen.
  const current = before.teams.find((team) => team.id === teamId);
  if (current !== undefined) {
    const owners = current.members.filter((member) => member.role === 'owner');
    const holders = (await store.usersByIds(owners.map((member) => member.userId)))
      .filter((user) => user.passwordHash !== undefined)
      .map((user) => user.id);
    const allowed = await attempt(() =>
      Promise.resolve().then(() => changedMembers(current.members, userId, to, new Set(holders))),
    );
    if (!allowed.ok) {
      return allowed;
    }
  }

  // What the account would hold after the change, to see which sites of this
  // team it stops being an admin of.
  const after: Holding = {
    rows: before.rows,
    teams: [
      ...before.teams.filter((team) => team.id !== teamId),
      ...(to === null
        ? []
        : [{ id: teamId, name: teamId, members: [{ userId, role: to.role, identity: to.identity }] }]),
    ],
  };
  const sites = (await store.sites()).filter((site) => teamIdOf(site) === teamId);
  const losingAdmin = sites.filter(
    (site) =>
      (grantWith(before, site, userId)?.scopes.has('admin') ?? false) &&
      !(grantWith(after, site, userId)?.scopes.has('admin') ?? false),
  );
  const keys = await keysMadeBy(store, userId, losingAdmin);
  if (keys.length > 0 && input.keys === 'ask') {
    return {
      ok: false,
      status: 409,
      code: 'KEYS_DECISION_REQUIRED',
      message: KEYS_DECISION_REQUIRED,
      details: { keys },
    };
  }

  const changed = await attempt(() => store.changeTeamMember(teamId, userId, to));
  if (!changed.ok) {
    return changed;
  }

  const old = standing(was);
  const now = standing(to === null ? undefined : to);
  const lowered = was !== undefined && (now.rank < old.rank || (old.identity && !now.identity));
  const followed = await follow({
    deps,
    userId,
    actor: input.actor,
    scope: { kind: 'team', id: teamId },
    action: to === null ? 'member:remove' : 'member:set',
    route: input.route,
    lowered,
    keys,
    decision: input.keys,
    changed: [`role: ${said(was?.role, was?.identity)} > ${said(to?.role, to?.identity)}`],
  });
  return { ok: true, team: changed.data, ...followed };
}

export interface SiteChangeInput {
  site: Site;
  userId: string;
  // Null takes the row off.
  to: Pick<SiteMember, 'role' | 'identity'> | null;
  actor: AuditRecord['actor'];
  route: string;
  keys: KeysDecision;
}

// Give somebody a role on one site, change it, or take it off.
export async function changeSiteMembership(
  deps: MembersDeps,
  input: SiteChangeInput,
): Promise<MembershipOutcome<{ members: SiteMember[] }>> {
  const { store } = deps;
  const { site, userId, to } = input;

  const before = await holdingOf(store, userId);
  const was = before.rows.find((row) => row.siteId === site.id);
  if (to === null && was === undefined) {
    return {
      ok: false,
      status: 404,
      code: 'UNKNOWN_MEMBER',
      message: `${userId} holds no role on ${site.id}`,
    };
  }
  const after: Holding = {
    teams: before.teams,
    rows: [
      ...before.rows.filter((row) => row.siteId !== site.id),
      ...(to === null ? [] : [{ siteId: site.id, userId, role: to.role, identity: to.identity }]),
    ],
  };
  const grantBefore = grantWith(before, site, userId);
  const grantAfter = grantWith(after, site, userId);
  const losingAdmin =
    (grantBefore?.scopes.has('admin') ?? false) && !(grantAfter?.scopes.has('admin') ?? false);
  const keys = losingAdmin ? await keysMadeBy(store, userId, [site]) : [];
  if (keys.length > 0 && input.keys === 'ask') {
    return {
      ok: false,
      status: 409,
      code: 'KEYS_DECISION_REQUIRED',
      message: KEYS_DECISION_REQUIRED,
      details: { keys },
    };
  }

  const written = await attempt(async () => {
    if (to === null) {
      await store.removeSiteMember(site.id, userId);
    } else {
      await store.setSiteMember({ siteId: site.id, userId, role: to.role, identity: to.identity });
    }
  });
  if (!written.ok) {
    return written;
  }

  const followed = await follow({
    deps,
    userId,
    actor: input.actor,
    scope: { kind: 'site', id: site.id },
    action: to === null ? 'member:remove' : 'member:set',
    route: input.route,
    // On the site itself, from what they could do before and can do now, so a
    // row a team owner holds (which decides nothing) lowers nobody.
    lowered: lost(grantBefore, grantAfter),
    keys,
    decision: input.keys,
    changed: [`role: ${said(was?.role, was?.identity)} > ${said(to?.role, to?.identity)}`],
  });
  return { ok: true, members: await store.siteMembers(site.id), ...followed };
}
