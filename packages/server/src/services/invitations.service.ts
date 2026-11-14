import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { attempt, type Refusal } from '../lib/store-error.js';
import {
  invitationState,
  type AccessScope,
  type AccountStore,
  type AnalyticsStore,
  type AuditRecord,
  type InvitationRecord,
  type InvitationState,
  type Role,
  type StoredUser,
} from '../store/AnalyticsStore.js';
import { recordAccessChange, type AccessAction } from './audit.service.js';
import { hashPassword } from './auth.service.js';
import {
  changeSiteMembership,
  changeTeamMembership,
  holdingOf,
  maySend,
  memberIn,
  said,
} from './members.service.js';
import { MANAGED_BY_SSO, isSsoManaged } from './sso-accounts.js';

// Invitations (AN-TEAM01): a link that lets one address take one role, once.
//
// Until this, the only way to add a colleague was for an owner to type that
// colleague's password for them. An invitation turns that round: the owner
// names an address and a role, gets a link, and sends it; whoever opens it
// chooses their own password and arrives with exactly the role that was
// picked.
//
// The core has no way to send mail, so the link is shown once to whoever
// made the invitation and they send it themselves. That makes it a bearer
// secret for an address that has no account yet: whoever holds it first can
// use it. So everything about it is built to be worth as little as possible
// to anybody else:
//
// - The token is 256 bits from the system random source. Only its SHA-256 is
//   stored, as an API key's is, and no read ever hands the hash back.
// - It is used once: the store's claim compares and sets in one write.
// - It expires (INVITE_TTL_HOURS, a week by default) and can be revoked.
// - It rides in the link's fragment, which a browser never sends to a server,
//   and reaches this server only in a request body. It is in no path, no
//   query, no log line and no audit row; rows name the invitation by its id.
// - An address that already has an account can only be accepted by that
//   account, signed in. The link alone never takes over somebody who exists.
// - It is never worth more than its sender: whoever sent it has to still be
//   allowed to send it at the moment it is used, not only when it was made.

export const INVITATION_TOKEN_PREFIX = 'chi_';
const TOKEN_BYTES = 32;

export function mintInvitationToken(): string {
  return `${INVITATION_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface InvitationDeps {
  store: AnalyticsStore & AccountStore;
  invites: { ttlMs: number };
  now(): number;
}

export type InvitationOutcome<T> = ({ ok: true } & T) | ({ ok: false } & Refusal);

function refuse(status: number, code: string, message: string): { ok: false } & Refusal {
  return { ok: false, status, code, message };
}

// An invitation as a list shows it, with what it is at this moment.
export interface ListedInvitation extends InvitationRecord {
  state: InvitationState;
  // Whether the link would work if it were opened now: waiting, and sent by
  // somebody who could still send it. Worked out when the list is read and
  // written nowhere, so a list never says "waiting" for a link that answers
  // 410 because its sender has since lost the right.
  usable: boolean;
}

function listed(invitation: InvitationRecord, now: number, senderMaySend: boolean): ListedInvitation {
  const state = invitationState(invitation, now);
  return { ...invitation, state, usable: state === 'pending' && senderMaySend };
}

// Whether an account already holds a place on the scope an invitation is to:
// in the team, or a row on the site. Inviting them there again would at best
// do nothing and at worst lower them, so it is refused when it is made and
// again when it is used.
async function alreadyOn(
  store: AccountStore,
  userId: string,
  scope: AccessScope,
): Promise<boolean> {
  const holding = await holdingOf(store, userId);
  return scope.kind === 'team'
    ? memberIn(holding, scope.id, userId) !== undefined
    : holding.rows.some((row) => row.siteId === scope.id);
}

const ALREADY_MEMBER = 'That address already has a role there. Change it from the list instead';

export interface CreateInvitationInput {
  scope: AccessScope;
  email: string;
  role: Role;
  identity: boolean;
  // Who is sending it: a person, signed in, already checked by the route to
  // own the team or to hold admin on the site.
  actor: AuditRecord['actor'];
  route: string;
}

export async function createInvitation(
  deps: InvitationDeps,
  input: CreateInvitationInput,
): Promise<InvitationOutcome<{ invitation: ListedInvitation; token: string }>> {
  const { store } = deps;
  const email = input.email.toLowerCase();
  const holder = await store.userByEmail(email);
  if (holder !== null) {
    // An account another application signs in is managed there: an
    // invitation would give it a place that outlives what that application
    // later takes away.
    if (isSsoManaged(holder.id)) {
      return refuse(MANAGED_BY_SSO.status, MANAGED_BY_SSO.code, MANAGED_BY_SSO.message);
    }
    if (await alreadyOn(store, holder.id, input.scope)) {
      return refuse(409, 'ALREADY_MEMBER', ALREADY_MEMBER);
    }
  }

  const token = mintInvitationToken();
  const now = deps.now();
  const invitation = {
    id: `inv_${randomUUID()}`,
    tokenHash: hashInvitationToken(token),
    email,
    scope: input.scope,
    role: input.role,
    identity: input.identity,
    invitedBy: input.actor.id,
    createdAt: now,
    expiresAt: now + deps.invites.ttlMs,
  };
  const created = await attempt(() => store.createInvitation(invitation));
  if (!created.ok) {
    return created;
  }
  await recordAccessChange(store, {
    scope: input.scope,
    actor: input.actor,
    action: 'invite:create',
    route: input.route,
    // Who it is to. The invitation is named by its id, never by its token.
    target: email,
    fields: [`invitation ${invitation.id}`, `role: ${said(input.role, input.identity)}`],
    at: now,
  });
  const { tokenHash: _tokenHash, ...record } = invitation;
  // Just made by somebody the route had checked may send it.
  return { ok: true, invitation: listed(record, now, true), token };
}

export async function listInvitations(
  deps: InvitationDeps,
  scope: AccessScope,
): Promise<ListedInvitation[]> {
  const now = deps.now();
  const open = await deps.store.openInvitations(scope);
  // One look per sender, however many each sent.
  const standing = new Map<string, boolean>();
  for (const invitation of open) {
    if (!standing.has(invitation.invitedBy)) {
      standing.set(
        invitation.invitedBy,
        await maySend(
          deps.store,
          await holdingOf(deps.store, invitation.invitedBy),
          invitation.invitedBy,
          invitation.scope,
        ),
      );
    }
  }
  return open.map((invitation) => listed(invitation, now, standing.get(invitation.invitedBy) ?? false));
}

export interface RevokeInvitationInput {
  scope: AccessScope;
  invitationId: string;
  actor: AuditRecord['actor'];
  route: string;
}

export async function revokeInvitation(
  deps: InvitationDeps,
  input: RevokeInvitationInput,
): Promise<InvitationOutcome<{ invitation: ListedInvitation }>> {
  const { store } = deps;
  const found = await store.invitation(input.invitationId);
  // On this team or this site, or it is not this caller's to revoke: an id
  // from somewhere else answers as if there were no such invitation.
  if (
    found === null ||
    found.scope.kind !== input.scope.kind ||
    found.scope.id !== input.scope.id
  ) {
    return refuse(404, 'UNKNOWN_INVITATION', 'No invitation there answers to that id');
  }
  const now = deps.now();
  if (!(await store.revokeInvitation(found.id, now, input.actor.id))) {
    return refuse(409, 'INVITATION_CLOSED', 'That invitation was already used or revoked');
  }
  await recordAccessChange(store, {
    scope: input.scope,
    actor: input.actor,
    action: 'invite:revoke',
    route: input.route,
    target: found.email,
    fields: [`invitation ${found.id}`],
    at: now,
  });
  return {
    ok: true,
    invitation: listed({ ...found, revokedAt: now, revokedBy: input.actor.id }, now, false),
  };
}

// An invitation that can be used right now, or why not. One place decides,
// for looking at one and for using one, so the two cannot disagree.
async function usable(
  deps: InvitationDeps,
  token: string,
): Promise<InvitationOutcome<{ invitation: InvitationRecord }>> {
  const { store } = deps;
  const invitation = await store.invitationByHash(hashInvitationToken(token));
  if (invitation === null) {
    return refuse(404, 'INVITATION_NOT_FOUND', 'That invitation link is not one this install made');
  }
  const state = invitationState(invitation, deps.now());
  if (state === 'accepted') {
    return refuse(410, 'INVITATION_USED', 'That invitation has already been used');
  }
  if (state === 'revoked') {
    return refuse(410, 'INVITATION_REVOKED', 'That invitation was withdrawn');
  }
  if (state === 'expired') {
    return refuse(410, 'INVITATION_EXPIRED', 'That invitation has expired. Ask for a new one');
  }
  // Where it is to still has to be there. Looked at here, before anything is
  // spent, so a link to a site or a team that has gone is refused as that and
  // leaves no account behind with nothing to belong to.
  if (invitation.scope.kind === 'site' && (await store.site(invitation.scope.id)) === null) {
    return refuse(404, 'UNKNOWN_SITE', 'The site that invitation was to is no longer there');
  }
  if (invitation.scope.kind === 'team' && (await store.team(invitation.scope.id)) === null) {
    return refuse(404, 'UNKNOWN_TEAM', 'The team that invitation was to is no longer there');
  }
  // Never worth more than its sender, at the moment it is used. Somebody who
  // was an owner when they sent it and is not one now could not send it
  // today, so it cannot be used today. A change made through this dashboard
  // has already revoked it (members.service.ts); this is what holds for a
  // change that came another way, and for the instant between the two.
  const sender = await holdingOf(store, invitation.invitedBy);
  if (!(await maySend(store, sender, invitation.invitedBy, invitation.scope))) {
    return refuse(
      410,
      'INVITATION_REVOKED',
      'Whoever sent that invitation can no longer invite people there. Ask for a new one',
    );
  }
  return { ok: true, invitation };
}

async function scopeName(store: AnalyticsStore & AccountStore, scope: AccessScope): Promise<string> {
  if (scope.kind === 'team') {
    return (await store.team(scope.id))?.name ?? scope.id;
  }
  return (await store.site(scope.id))?.name ?? scope.id;
}

// What somebody holding the link is shown before they type anything: what it
// is for and who sent it, so they can tell it is the one they were expecting.
export interface InvitationPreview {
  email: string;
  scope: { kind: AccessScope['kind']; id: string; name: string };
  role: Role;
  identity: boolean;
  invitedBy: string;
  expiresAt: number;
  // Whether the address already has an account, which decides what the page
  // asks for: a sign-in, or a name and a password.
  accountExists: boolean;
}

export async function lookupInvitation(
  deps: InvitationDeps,
  token: string,
): Promise<InvitationOutcome<{ preview: InvitationPreview }>> {
  const found = await usable(deps, token);
  if (!found.ok) {
    return found;
  }
  const { invitation } = found;
  const [sender, holder, name] = await Promise.all([
    deps.store.userById(invitation.invitedBy),
    deps.store.userByEmail(invitation.email),
    scopeName(deps.store, invitation.scope),
  ]);
  return {
    ok: true,
    preview: {
      email: invitation.email,
      scope: { kind: invitation.scope.kind, id: invitation.scope.id, name },
      role: invitation.role,
      identity: invitation.identity,
      invitedBy: sender?.name ?? sender?.email ?? 'An owner',
      expiresAt: invitation.expiresAt,
      accountExists: holder !== null,
    },
  };
}

export interface AcceptInvitationInput {
  token: string;
  // The account signed in on the request, if any.
  sessionUserId: string | null;
  // For an address with no account yet. Already validated by the route to
  // registration's rule.
  password?: string;
  name?: string;
  route: string;
}

export interface AcceptedInvitation {
  user: StoredUser;
  // Whether the account was made by this acceptance, in which case the
  // caller signs them in.
  created: boolean;
  scope: AccessScope;
  role: Role;
}

export async function acceptInvitation(
  deps: InvitationDeps,
  input: AcceptInvitationInput,
): Promise<InvitationOutcome<AcceptedInvitation>> {
  const { store } = deps;
  const found = await usable(deps, input.token);
  if (!found.ok) {
    return found;
  }
  const { invitation } = found;

  // Who is accepting. An address that has an account is accepted by that
  // account and by nobody else: the link is not a way into somebody who is
  // already here.
  const holder = await store.userByEmail(invitation.email);
  if (holder !== null) {
    if (isSsoManaged(holder.id)) {
      return refuse(MANAGED_BY_SSO.status, MANAGED_BY_SSO.code, MANAGED_BY_SSO.message);
    }
    if (input.sessionUserId === null) {
      return refuse(
        401,
        'SIGN_IN_REQUIRED',
        'An account already uses that address. Sign in to it, then open the invitation again',
      );
    }
    if (input.sessionUserId !== holder.id) {
      return refuse(
        403,
        'INVITATION_ADDRESS_MISMATCH',
        'That invitation is for another address. Sign in as the account it was sent to',
      );
    }
    if (await alreadyOn(store, holder.id, invitation.scope)) {
      return refuse(409, 'ALREADY_MEMBER', ALREADY_MEMBER);
    }
  } else {
    if (input.sessionUserId !== null) {
      // Signed in as somebody, and the invitation is for an address that is
      // not theirs. Making a second account from inside the first one's
      // session would be a surprise to both.
      return refuse(
        403,
        'INVITATION_ADDRESS_MISMATCH',
        'That invitation is for another address. Sign out, then open it again',
      );
    }
    if (input.password === undefined) {
      return refuse(400, 'PASSWORD_REQUIRED', 'Choose a password of at least 12 characters');
    }
  }

  // Everything that can be refused has been, and everything slow is done,
  // before the invitation is spent: the hash is the expensive step, and it is
  // only ever computed for a link that could be used.
  const userId = holder?.id ?? `u_${randomUUID()}`;
  const passwordHash =
    holder === null && input.password !== undefined ? await hashPassword(input.password) : undefined;

  // Spend it. One write that finds it open and unexpired and closes it; of
  // two acceptances at the same instant, one gets it and the other gets this.
  const claimed = await store.claimInvitation(hashInvitationToken(input.token), deps.now(), userId);
  if (claimed === null) {
    return refuse(410, 'INVITATION_USED', 'That invitation has already been used');
  }

  if (holder === null) {
    const made = await attempt(() =>
      store.createUser({
        id: userId,
        email: invitation.email,
        createdAt: deps.now(),
        ...(passwordHash === undefined ? {} : { passwordHash }),
        ...(input.name === undefined ? {} : { name: input.name }),
      }),
    );
    if (!made.ok) {
      // An account took the address between the look and the claim. The
      // invitation is spent and nothing was given; whoever sent it sends
      // another.
      return made;
    }
  }

  const actor: AuditRecord['actor'] = { kind: 'session', id: userId, email: invitation.email };
  const cause = { action: 'invite:accept' as const, note: `invitation ${invitation.id}` };
  const to = { role: invitation.role, identity: invitation.identity };
  const joined =
    invitation.scope.kind === 'team'
      ? await changeTeamMembership(deps, {
          teamId: invitation.scope.id,
          userId,
          to,
          actor,
          route: input.route,
          // An acceptance only ever adds, so there is nothing to ask about.
          keys: 'keep',
          cause,
        })
      : await acceptOnSite(deps, invitation.scope.id, userId, to, actor, input.route, cause);
  if (!joined.ok) {
    return joined;
  }

  const user = await store.userById(userId);
  if (user === null) {
    return refuse(500, 'INTERNAL_ERROR', 'The account could not be read back');
  }
  return {
    ok: true,
    user,
    created: holder === null,
    scope: invitation.scope,
    role: invitation.role,
  };
}

async function acceptOnSite(
  deps: InvitationDeps,
  siteId: string,
  userId: string,
  to: { role: Role; identity: boolean },
  actor: AuditRecord['actor'],
  route: string,
  cause: { action: AccessAction; note: string },
): Promise<InvitationOutcome<object>> {
  const site = await deps.store.site(siteId);
  if (site === null) {
    return refuse(404, 'UNKNOWN_SITE', `No site answers to ${siteId}`);
  }
  return changeSiteMembership(deps, { site, userId, to, actor, route, keys: 'keep', cause });
}
