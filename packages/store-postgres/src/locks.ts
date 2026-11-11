// Every advisory lock this adapter takes, in one place.
//
// An advisory lock is a number, and the number space belongs to the whole
// database rather than to a schema or a role: any other tool connected to the
// same database that happens to pick the same number waits on us, and we on
// it. So the keys are the two-integer form, the first integer a namespace
// nobody else is likely to choose (the bytes of "CHKH") and the second the
// purpose, and anything new takes the next purpose here rather than a number
// of its own somewhere else.
//
// All of them are transaction locks (pg_advisory_xact_lock), released by the
// commit or the rollback that ends the work they guard, so a process that dies
// holding one cannot leave it held.
export const LOCK_NAMESPACE = 0x43484b48;

// `migrate --apply`: two processes applying the schema at once (two replicas
// starting with the same one-shot migration) take turns, and the second finds
// nothing left to create.
export const LOCK_MIGRATE = 1;

// Creating or dropping a partition of events: two processes that meet the
// first batch of a new month at the same moment take turns, and the second
// finds the month already there.
export const LOCK_PARTITIONS = 2;

export function advisoryLockSql(purpose: number): string {
  return `SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${purpose})`;
}
