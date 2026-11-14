import type { Principal } from '../lib/scopes.js';
import type { AccessScope, AccountStore, AuditRecord } from '../store/AnalyticsStore.js';

// One row per response that carried an address, a userId or a trait.
//
// Called with the field list the identity gate produced, from the same pass that
// built the body, so the log cannot drift from what was actually sent. An empty
// list writes nothing: a realtime snapshot of anonymous visitors reveals nobody
// and does not belong in a log whose whole purpose is "who looked at this
// person".
//
// The write is awaited. An audit row that might not have been written is not an
// audit row, and one insert beside a read that already cost an aggregation is
// not the thing to optimise.

export interface IdentityRead {
  principal: Principal;
  siteId: string;
  // As the route is registered, not as it was requested: a path with the id in
  // it would put the person's id in two columns and make the log harder to group.
  route: string;
  target?: string;
  fields: string[];
  at: number;
}

export async function recordIdentityRead(store: AccountStore, read: IdentityRead): Promise<void> {
  if (read.fields.length === 0) {
    return;
  }
  if (read.principal.kind === 'share') {
    // A share holds read:stats alone and no identity route is registered
    // under it, so this is a defect and not a row.
    throw new Error('A share principal never reads identity');
  }
  const actor = actorOf(read.principal);
  const row: AuditRecord = {
    siteId: read.siteId,
    ts: read.at,
    actor,
    action: 'read:identity',
    route: read.route,
    fields: read.fields,
  };
  if (read.target !== undefined) {
    row.target = read.target;
  }
  await store.audit(row);
}

// Who an audit row says acted, for a person signed in or a key.
export function actorOf(principal: Principal): AuditRecord['actor'] {
  if (principal.kind === 'share') {
    // A share link reads numbers and nothing else; it changes no access and
    // reads no identity, so a row with one as its actor is a defect.
    throw new Error('A share principal is never the actor of an audit row');
  }
  const actor: AuditRecord['actor'] = { kind: principal.kind, id: principal.id };
  if (principal.email !== undefined) {
    actor.email = principal.email;
  }
  return actor;
}

// One row per change to who may reach a site or a team (AN-TEAM01): a role
// set or taken away, an invitation sent, revoked or used. About the site when
// the change is to a site and about the team when it is to a team, never
// both, so each log is read by the people who may read it.
//
// The target is an account's id or an invitation's id. Never a token: an
// invitation's token is not in any row, any log line or any field here.
export interface AccessChange {
  scope: AccessScope;
  actor: AuditRecord['actor'];
  action: string;
  route: string;
  target?: string;
  // What changed, as short phrases a person can read in a list.
  fields: string[];
  at: number;
}

export async function recordAccessChange(store: AccountStore, change: AccessChange): Promise<void> {
  const row: AuditRecord = {
    ...(change.scope.kind === 'site' ? { siteId: change.scope.id } : { teamId: change.scope.id }),
    ts: change.at,
    actor: change.actor,
    action: change.action,
    route: change.route,
    fields: change.fields,
  };
  if (change.target !== undefined) {
    row.target = change.target;
  }
  await store.audit(row);
}
