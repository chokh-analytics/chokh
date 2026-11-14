import {
  listingFilters,
  type AuditCursorCodec,
  type AuditListing,
} from '../lib/audit-cursor.js';
import { gateAuditPage, type AuditAccount } from '../lib/identity-gate.js';
import type { Principal } from '../lib/scopes.js';
import { attempt, type Outcome } from '../lib/store-error.js';
import type { AuditKind } from '../schemas/audit.schema.js';
import type {
  AccessScope,
  AccountStore,
  AuditEntry,
  AuditPageQuery,
  AuditRecord,
} from '../store/AnalyticsStore.js';

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
//
// Every action such a row may carry is in this list, and the type is what
// holds a new one to being added here: the log's "access" filter is this
// list, so a change written under a name that is not in it would be a row no
// filter finds.
export const ACCESS_ACTIONS = [
  'member:set',
  'member:remove',
  // An arrival through the SSO exchange that the last-owner rule turned away.
  'member:refused',
  'invite:create',
  'invite:revoke',
  'invite:accept',
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export interface AccessChange {
  scope: AccessScope;
  actor: AuditRecord['actor'];
  action: AccessAction;
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

// Reading the log (AN-TEAM01).
//
// The three kinds a reader can ask for, and what each covers. Every action
// this server writes is in exactly one.
const IDENTITY_READ = 'read:identity';
const LOG_READ = 'read:audit';
const ACTIONS_BY_KIND: Readonly<Record<AuditKind, readonly string[]>> = {
  identity: [IDENTITY_READ],
  access: ACCESS_ACTIONS,
  log: [LOG_READ],
};

export function kindOfAction(action: string): AuditKind | 'other' {
  for (const kind of Object.keys(ACTIONS_BY_KIND) as AuditKind[]) {
    if (ACTIONS_BY_KIND[kind].includes(action)) return kind;
  }
  // A row from a version that wrote an action this one does not know.
  return 'other';
}

// A row as the API shows it: the store's row, and which kind it is.
export interface ListedAuditRow extends AuditEntry {
  kind: AuditKind | 'other';
}

export interface AuditLogPage {
  rows: ListedAuditRow[];
  // The accounts the rows name, by id, as they are now. Empty for a caller
  // without read:identity.
  accounts: Record<string, AuditAccount>;
  next: string | null;
}

export interface AuditLogRead {
  scope: AccessScope;
  principal: Principal;
  // Whether the caller holds read:identity on what the log is about.
  allowed: boolean;
  // As the route is registered.
  route: string;
  limit: number;
  cursor?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  actorId?: string | undefined;
  kind?: AuditKind | undefined;
  target?: string | undefined;
}

export interface AuditLogDeps {
  store: AccountStore;
  auditCursor: AuditCursorCodec;
  now(): number;
}

function refuse(status: number, code: string, message: string): Outcome<never> {
  return { ok: false, status, code, message };
}

// Whose accounts a page names: who acted, when that was an account and not a
// key, and who a change of access was made to. Never the target of a read:
// that is a visitor of the site, and looking it up among the accounts of this
// install would be a guess that an id means the same thing in both places.
function accountIdsOf(rows: readonly AuditEntry[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.actor.kind !== 'key') ids.add(row.actor.id);
    if (row.target !== undefined && kindOfAction(row.action) === 'access') ids.add(row.target);
  }
  return [...ids];
}

// One page of a site's log or a team's, newest first.
//
// Whether the caller may read this log at all is the route's to decide (admin
// on the site, an owner of the team). What is decided here is what they see of
// it and what the reading leaves behind:
//
// - Opening the log is recorded. A read with no cursor writes one read:audit
//   row; a later page of the same listing writes none, the way a stream is one
//   row for the act and not one per frame. A cursor is only ever one this
//   server gave out for this listing (lib/audit-cursor.ts), so there is no way
//   to read the log that does not begin with a recorded opening.
// - Asking by target is asking about a named person, so it needs read:identity
//   and is refused without it before the store is asked anything.
// - The page goes through the identity gate, and the row this read writes
//   lists what survived it, from the same pass.
export async function readAuditLog(
  deps: AuditLogDeps,
  read: AuditLogRead,
): Promise<Outcome<{ page: AuditLogPage; fields: string[] }>> {
  if (read.principal.kind === 'share') {
    throw new Error('A share principal never reads the audit log');
  }
  if (read.target !== undefined && !read.allowed) {
    return refuse(
      403,
      'SCOPE_REQUIRED',
      'Asking the log about one target is asking about a named person, so it needs the read:identity scope',
    );
  }
  const now = deps.now();
  const listing: AuditListing = {
    scope: read.scope,
    readerId: read.principal.id,
    filters: listingFilters(read),
  };
  const query: AuditPageQuery = { scope: read.scope, limit: read.limit };
  if (read.from !== undefined) query.from = read.from;
  if (read.to !== undefined) query.to = read.to;
  if (read.actorId !== undefined) query.actorId = read.actorId;
  if (read.kind !== undefined) query.actions = [...ACTIONS_BY_KIND[read.kind]];
  if (read.target !== undefined) query.target = read.target;

  let openedAt = now;
  if (read.cursor !== undefined) {
    const held = deps.auditCursor.read(read.cursor, listing, now);
    if (held === null) {
      return refuse(400, 'INVALID_CURSOR', 'That cursor was not written by this server for this listing');
    }
    if (held === 'expired') {
      return refuse(
        400,
        'CURSOR_EXPIRED',
        'That listing was opened too long ago to carry on from; open the log again',
      );
    }
    query.after = held.after;
    openedAt = held.openedAt;
  }

  const found = await attempt(() => deps.store.auditPage(query));
  if (!found.ok) {
    return found;
  }
  const accounts: Record<string, AuditAccount> = {};
  if (read.allowed) {
    for (const user of await deps.store.usersByIds(accountIdsOf(found.data.rows))) {
      accounts[user.id] = { email: user.email, ...(user.name === undefined ? {} : { name: user.name }) };
    }
  }
  const gated = gateAuditPage({ rows: found.data.rows, accounts }, read.allowed);

  if (read.cursor === undefined) {
    // After the page was read, so an opening does not show itself, and awaited
    // like every other row here: a read of the log that might not have been
    // recorded is the thing this row exists to rule out.
    const row: AuditRecord = {
      ...(read.scope.kind === 'site' ? { siteId: read.scope.id } : { teamId: read.scope.id }),
      ts: now,
      actor: actorOf(read.principal),
      action: LOG_READ,
      route: read.route,
      fields: gated.fields,
    };
    // "Who asked the log about Ada" is a question the log should answer too.
    if (read.target !== undefined) row.target = read.target;
    await deps.store.audit(row);
  }

  return {
    ok: true,
    data: {
      page: {
        rows: gated.value.rows.map((row) => ({ ...row, kind: kindOfAction(row.action) })),
        accounts: gated.value.accounts,
        next:
          found.data.next === null ? null : deps.auditCursor.issue(found.data.next, openedAt, listing),
      },
      fields: gated.fields,
    },
  };
}
