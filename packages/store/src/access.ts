import type { AuditRecord, Role, StoredTeam, StoredUser, TeamMember } from './accounts.js';
import { StoreQueryError } from './query.js';

// Who may reach what, beyond the team a site belongs to (AN-TEAM01): a role on
// one site, an invitation, an account's outside identity, the rule that keeps
// a team from losing its last owner, and the audit log read a page at a time.
//
// The shapes and the rules are here, beside the contract, for the reason the
// read plan is: every adapter has to give the same answer, so the answer is
// written once and each adapter only decides how to make it atomic.

// A team or a site. An invitation is to one of them and an audit row is about
// one of them.
export type AccessScope = { kind: 'team'; id: string } | { kind: 'site'; id: string };

// A role on one site, held by somebody who may or may not be in the team that
// owns it. The server decides what it means beside a team role (an owner of
// the team is an owner of every site in it, whatever a row here says); the
// store only keeps one row per person and site.
export interface SiteMember {
  siteId: string;
  userId: string;
  role: Role;
  identity: boolean;
}

// An invitation: a link that lets one address take one role once.
//
// The token itself is never stored. It is 256 bits from the system random
// source, shown once to whoever sent the invitation, and what is kept is its
// SHA-256, for the reason an API key's is: there is nothing to guess, and the
// lookup has to go through a unique index.
export interface StoredInvitation {
  // What a list, a revoke and an audit row name. Never the token.
  id: string;
  tokenHash: string;
  // Lowercased by the adapter, as an account's address is.
  email: string;
  scope: AccessScope;
  role: Role;
  identity: boolean;
  // The account that sent it. An invitation is never worth more than its
  // sender is on the day it is used, and the server checks that then.
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  acceptedBy?: string;
  revokedAt?: number;
  revokedBy?: string;
}

// An invitation as a route may show it: everything but the hash.
export type InvitationRecord = Omit<StoredInvitation, 'tokenHash'>;

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

// What an invitation is at one moment. Accepted and revoked are facts written
// on the row; expired is only the clock, so a row can be open and expired at
// once, which is why every adapter's claim compares the instant itself.
export function invitationState(
  invitation: Pick<StoredInvitation, 'acceptedAt' | 'revokedAt' | 'expiresAt'>,
  now: number,
): InvitationState {
  if (invitation.acceptedAt !== undefined) return 'accepted';
  if (invitation.revokedAt !== undefined) return 'revoked';
  return invitation.expiresAt > now ? 'pending' : 'expired';
}

// How many invitations one team or one site may have waiting. A ceiling
// rather than a rate: what it stops is a list nobody can read and a table
// somebody fills by script.
export const MAX_PENDING_INVITATIONS = 50;

const ROLE_NAMES: readonly string[] = ['owner', 'editor', 'viewer'];

// Refused before anything is written, the same way by every adapter.
export function checkInvitation(invitation: StoredInvitation): void {
  const refuse = (why: string): never => {
    throw new StoreQueryError('INVALID_INVITATION', why);
  };
  if (invitation.id === '' || invitation.tokenHash === '') refuse('An invitation needs an id and a token hash');
  if (invitation.email === '') refuse('An invitation is for an address');
  if (invitation.scope.kind !== 'team' && invitation.scope.kind !== 'site') {
    refuse('An invitation is to a team or to a site');
  }
  if (invitation.scope.id === '') refuse('An invitation names the team or the site it is to');
  if (!ROLE_NAMES.includes(invitation.role)) refuse('An invitation carries a role of owner, editor or viewer');
  if (!(invitation.expiresAt > invitation.createdAt)) refuse('An invitation expires after it is made');
  if (
    invitation.acceptedAt !== undefined ||
    invitation.acceptedBy !== undefined ||
    invitation.revokedAt !== undefined ||
    invitation.revokedBy !== undefined
  ) {
    refuse('An invitation is created open: it is accepted by a claim and revoked by a revoke');
  }
}

// An account's identity somewhere else: the issuer of an OpenID Connect
// provider and the subject it gave this person. The pair is the only thing
// such a provider promises is stable and unique, so it is the only thing an
// account is ever found by; an address in a token finds nobody.
//
// The rows only. What speaks the protocol is packages/ee, and a core-only
// install writes none.
export interface StoredIdentity {
  issuer: string;
  subject: string;
  userId: string;
  linkedAt: number;
}

// What a member becomes. Null takes them out of the team.
export interface TeamMemberChange {
  role: Role;
  identity: boolean;
}

// A team's members after one change, or the refusal.
//
// Two rules, and both are about never leaving an install nobody can enter. A
// team that has an owner keeps one. And a team that has an owner who can sign
// in with a password keeps one of those: an account that arrives only through
// another application or an identity provider is locked out the day that
// application is down or a licence lapses, and somebody has to be able to get
// in and put it right. `passwordHolders` is which of the team's members have a
// password, read by the adapter in the same breath as the members.
//
// A team with no owner at all (one the SSO exchange made and filled with
// viewers) has nothing to protect, so nothing is refused there.
//
// The position of a member who stays is kept, and a new one goes to the end.
export function changedMembers(
  members: readonly TeamMember[],
  userId: string,
  to: TeamMemberChange | null,
  passwordHolders: ReadonlySet<string>,
): TeamMember[] {
  const at = members.findIndex((member) => member.userId === userId);
  if (to === null && at === -1) {
    throw new StoreQueryError('UNKNOWN_MEMBER', `${userId} is not a member of that team`);
  }
  const next = members.map((member) => ({ ...member }));
  if (to === null) {
    next.splice(at, 1);
  } else if (at === -1) {
    next.push({ userId, role: to.role, identity: to.identity });
  } else {
    next[at] = { userId, role: to.role, identity: to.identity };
  }

  const ownersOf = (list: readonly TeamMember[]): string[] =>
    list.filter((member) => member.role === 'owner').map((member) => member.userId);
  const before = ownersOf(members);
  const after = ownersOf(next);
  if (before.length > 0 && after.length === 0) {
    throw new StoreQueryError('LAST_OWNER', 'A team keeps at least one owner');
  }
  const hadPassword = before.some((id) => passwordHolders.has(id));
  const hasPassword = after.some((id) => passwordHolders.has(id));
  if (hadPassword && !hasPassword) {
    throw new StoreQueryError(
      'LAST_OWNER',
      'A team keeps at least one owner who can sign in with a password',
    );
  }
  return next;
}

// How many rows of the log one read may ask for.
export const MAX_AUDIT_PAGE = 200;

// Where a page of the log ended: the instant of its last row and that row's
// id, because two rows of one millisecond need something to tell them apart or
// a page boundary between them shows one twice or not at all.
export interface AuditCursor {
  ts: number;
  id: string;
}

export interface AuditPageQuery {
  // A site's rows or a team's. Never both: who may read each is different.
  scope: AccessScope;
  // [from, to), either end optional.
  from?: number;
  to?: number;
  // The account or the key that acted.
  actorId?: string;
  // Any of these actions.
  actions?: string[];
  // Exactly this target: "who looked at this person" is the question the log
  // exists to answer.
  target?: string;
  limit: number;
  after?: AuditCursor;
}

// A row of the log with the id its adapter knows it by. The id means nothing
// outside the adapter that made it.
export interface AuditEntry extends AuditRecord {
  id: string;
}

export interface AuditPage {
  // Newest first.
  rows: AuditEntry[];
  // Where to carry on from, or null when this was the last page.
  next: AuditCursor | null;
}

// A row is about a site or about a team, never both and never neither. A row
// about neither could be read by nobody, and a row about both would be read by
// two audiences who were promised different things.
export function checkAuditRow(row: AuditRecord): void {
  const site = row.siteId !== undefined && row.siteId !== '';
  const team = row.teamId !== undefined && row.teamId !== '';
  if (site === team) {
    throw new StoreQueryError(
      'INVALID_AUDIT_ROW',
      'An audit row is about one site or about one team, never both and never neither',
    );
  }
}

export function checkAuditPage(query: AuditPageQuery): void {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_AUDIT_PAGE) {
    throw new StoreQueryError(
      'INVALID_AUDIT_QUERY',
      `A page of the audit log is 1 to ${MAX_AUDIT_PAGE} rows`,
    );
  }
  if (query.scope.kind !== 'team' && query.scope.kind !== 'site') {
    throw new StoreQueryError('INVALID_AUDIT_QUERY', 'The audit log is read for a site or a team');
  }
  if (query.after !== undefined && !Number.isFinite(query.after.ts)) {
    throw new StoreQueryError('INVALID_CURSOR', 'That cursor was not written by this store');
  }
}

// Whether a row is one a query asked for, cursor aside. The memory adapter
// filters with it; the others say the same thing to their database.
export function matchesAudit(row: AuditRecord, query: AuditPageQuery): boolean {
  const scoped =
    query.scope.kind === 'site' ? row.siteId === query.scope.id : row.teamId === query.scope.id;
  if (!scoped) return false;
  if (query.from !== undefined && row.ts < query.from) return false;
  if (query.to !== undefined && row.ts >= query.to) return false;
  if (query.actorId !== undefined && row.actor.id !== query.actorId) return false;
  if (query.actions !== undefined && !query.actions.includes(row.action)) return false;
  if (query.target !== undefined && row.target !== query.target) return false;
  return true;
}

// The part of AccountStore this ticket adds, declared apart so each adapter
// can keep it in a file of its own, the way imported history is.
export interface AccessStore {
  // The accounts behind a list of ids, by id; an id nobody holds is left out.
  // One read for a member list, where userById would be one per row.
  usersByIds(userIds: string[]): Promise<StoredUser[]>;
  // End every session of one account: the counter the session cookie carries
  // goes up by one, in one write, and the new value is the answer. Refuses an
  // account nobody holds with UNKNOWN_USER.
  bumpSessionEpoch(userId: string): Promise<number>;

  // Change one member's role, add one, or (with null) take one out, under the
  // two rules of changedMembers. The rules are checked and the list written as
  // one act, so two owners lowering each other at the same moment cannot both
  // succeed. Refuses UNKNOWN_TEAM, UNKNOWN_MEMBER and LAST_OWNER.
  changeTeamMember(
    teamId: string,
    userId: string,
    to: TeamMemberChange | null,
  ): Promise<StoredTeam>;
  renameTeam(teamId: string, name: string): Promise<StoredTeam>;
  // Refuses UNKNOWN_TEAM, the default team with DEFAULT_TEAM, and a team that
  // still holds a site with TEAM_HAS_SITES. The team's own invitations go
  // with it.
  deleteTeam(teamId: string): Promise<void>;

  // The roles held on one site, by user id.
  siteMembers(siteId: string): Promise<SiteMember[]>;
  // Every site row one account holds, by site id. Read on every request of a
  // session, beside teamsForUser.
  siteGrantsForUser(userId: string): Promise<SiteMember[]>;
  // Add a row or change it. Refuses a site nobody registered with
  // UNKNOWN_SITE.
  setSiteMember(member: SiteMember): Promise<void>;
  // False when there was no such row.
  removeSiteMember(siteId: string, userId: string): Promise<boolean>;

  // Refuses a scope that does not exist with UNKNOWN_TEAM or UNKNOWN_SITE, a
  // second invitation still waiting for the same address on the same scope
  // with INVITATION_EXISTS, and one more than MAX_PENDING_INVITATIONS waiting
  // on the scope with INVITATION_LIMIT. An earlier invitation to that address
  // that expired unused is closed by this one, so it can be sent again.
  createInvitation(invitation: StoredInvitation): Promise<void>;
  // By the hash of the token presented, whatever state it is in.
  invitationByHash(tokenHash: string): Promise<InvitationRecord | null>;
  invitation(id: string): Promise<InvitationRecord | null>;
  // Neither accepted nor revoked, oldest first. An expired one is still here:
  // whoever sent it should see that it lapsed.
  openInvitations(scope: AccessScope): Promise<InvitationRecord[]>;
  // The open ones one account sent, oldest first, so they can be revoked when
  // that account loses the right to have sent them.
  invitationsSentBy(userId: string): Promise<InvitationRecord[]>;
  // True when it was open and is now revoked; false when it was already
  // accepted, already revoked, or never existed.
  revokeInvitation(id: string, at: number, by: string): Promise<boolean>;
  // Use it, once. One write that compares and sets: open, not expired at
  // `at`, and from then on accepted by `userId`. The invitation as it now is,
  // or null when it could not be used, and of several claims of one
  // invitation sent together exactly one is answered.
  claimInvitation(tokenHash: string, at: number, userId: string): Promise<InvitationRecord | null>;

  // Refuses an account nobody holds with UNKNOWN_USER, a pair another account
  // (or this one) already holds with IDENTITY_TAKEN, and a second identity of
  // one issuer on one account with IDENTITY_EXISTS.
  linkIdentity(identity: StoredIdentity): Promise<void>;
  userByIdentity(issuer: string, subject: string): Promise<StoredUser | null>;
  identitiesForUser(userId: string): Promise<StoredIdentity[]>;
  // False when there was nothing to unlink.
  unlinkIdentity(userId: string, issuer: string): Promise<boolean>;

  // One page of a site's log or a team's, newest first.
  auditPage(query: AuditPageQuery): Promise<AuditPage>;
}
