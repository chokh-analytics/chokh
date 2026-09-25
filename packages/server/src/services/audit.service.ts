import type { Principal } from '../lib/scopes.js';
import type { AccountStore, AuditRecord } from '../store/AnalyticsStore.js';

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
  const actor: AuditRecord['actor'] = { kind: read.principal.kind, id: read.principal.id };
  if (read.principal.email !== undefined) {
    actor.email = read.principal.email;
  }
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
