import type { Pool, PoolClient } from 'pg';

import { advisoryLockSql, LOCK_PARTITIONS } from './locks.js';
import { EVENTS } from './schema.js';

// The partitions of events: one per calendar month of UTC.
//
// A month, because the default retention is 180 days and the ceiling ten
// years: a handful of partitions for most installs, where a day each would be
// hundreds of tables with four indexes apiece for no better pruning than the
// (site_id, ts) index already gives inside a month. UTC, because sites in
// different zones share the table and a partition bound has to be one instant
// for all of them.
//
// This is the one place the adapter creates anything. Every table and index
// comes from `migrate --apply` and from nowhere else; a month's partition
// cannot, because which months exist depends on when the rows happened and no
// migration can know that ahead of them. So migrate makes the current month
// and the next, and ingest makes any other month a batch needs, here.

// How far back a partition may be created: the longest retention a site can
// be given (packages/server/src/schemas/accounts.schema.ts caps retentionDays
// at 3650). A row older than that is past every site's retention the moment
// it arrives, so the hourly purge would delete it within the hour; there is
// nothing to keep it in.
export const PARTITION_FLOOR_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Month {
  // events_p202609
  name: string;
  // Inclusive and exclusive, Unix milliseconds: the partition's bounds.
  from: number;
  to: number;
}

// What a partition is called: the parent's name, a p and six digits. A name is
// written into DDL as text, so nothing that is not exactly this is ever
// created, emptied or dropped, whatever a catalog holds.
const PARTITION_NAME = new RegExp(`^${EVENTS}_p[0-9]{6}$`);

function monthAt(year: number, month: number): Month {
  const from = Date.UTC(year, month, 1);
  const to = Date.UTC(year, month + 1, 1);
  const start = new Date(from);
  const label = `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { name: `${EVENTS}_p${label}`, from, to };
}

export function monthOf(ts: number): Month {
  const at = new Date(ts);
  return monthAt(at.getUTCFullYear(), at.getUTCMonth());
}

export function monthAfter(month: Month): Month {
  return monthOf(month.to);
}

// The instants a partition may exist for: from the month the floor falls in
// to the end of the month after this one.
//
// It is a bound on the number of tables, and it is the adapter's own rather
// than a caller's good manners. The collector and the server events route both
// clamp an event to the day before it arrived, so nothing they send is ever
// outside it; but ingest is a public method, and without this one batch with a
// row for every month of a century would create twelve hundred tables. With
// it, an install can never hold more than the months of PARTITION_FLOOR_DAYS and
// the one after this: 122 partitions, which a test counts.
export function partitionWindow(now: number): { from: number; to: number } {
  return {
    from: monthOf(now - PARTITION_FLOOR_DAYS * DAY_MS).from,
    to: monthAfter(monthOf(now)).to,
  };
}

export function inPartitionWindow(ts: number, now: number): boolean {
  if (!Number.isFinite(ts)) {
    return false;
  }
  const window = partitionWindow(now);
  return ts >= window.from && ts < window.to;
}

// The distinct months a list of instants falls in, oldest first. Instants
// outside the window are not in it: the caller decides what becomes of those
// rows, and no partition is made for them.
export function monthsFor(instants: readonly number[], now: number): Month[] {
  const months = new Map<string, Month>();
  for (const ts of instants) {
    if (!inPartitionWindow(ts, now)) {
      continue;
    }
    const month = monthOf(ts);
    months.set(month.name, month);
  }
  return [...months.values()].sort((left, right) => left.from - right.from);
}

export interface PartitionRow {
  name: string;
  from: number;
  to: number;
}

interface Queryable {
  query: PoolClient['query'];
}

// The partitions events has now, oldest first, with the bounds Postgres holds
// for them. Read from the catalog and scoped to the schema the connection is
// in, so two installs in two schemas of one database see only their own.
export async function listPartitions(db: Queryable): Promise<PartitionRow[]> {
  const result = await db.query<{ name: string; bound: string }>(
    `SELECT child.relname AS name, pg_get_expr(child.relpartbound, child.oid) AS bound
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE parent.relname = $1
        AND parent.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
    [EVENTS],
  );
  return result.rows
    .map((row) => {
      // FOR VALUES FROM ('1788220800000') TO ('1790812800000')
      const bounds = /FROM \('?(-?\d+)'?\) TO \('?(-?\d+)'?\)/.exec(row.bound);
      return {
        name: row.name,
        from: bounds === null ? Number.NaN : Number(bounds[1]),
        to: bounds === null ? Number.NaN : Number(bounds[2]),
      };
    })
    .sort((left, right) => left.from - right.from);
}

// Create one month's partition, inside the caller's transaction.
//
// A table made LIKE the parent and then attached, rather than CREATE TABLE ...
// PARTITION OF. The second takes an ACCESS EXCLUSIVE lock on events, so it
// waits for every report already reading the table and, while it waits, every
// ingest queues behind it: one slow read at the turn of a month would stall
// collection. ATTACH PARTITION takes a lock that conflicts with neither a
// reader nor a writer, and the new table is empty, so the check that its rows
// fit the bound is instant. The parent's indexes are built on it as it is
// attached.
//
// The caller holds LOCK_PARTITIONS, so nothing else is creating it.
export async function createPartition(db: Queryable, month: Month): Promise<boolean> {
  // The name and the two bounds are written into the statement: DDL takes no
  // parameters. They are this file's own arithmetic, and are checked as if
  // they were not.
  if (
    !PARTITION_NAME.test(month.name) ||
    !Number.isSafeInteger(month.from) ||
    !Number.isSafeInteger(month.to) ||
    month.to <= month.from
  ) {
    throw new Error('A partition is a month: a name of six digits and two whole instants');
  }
  const existing = await db.query('SELECT to_regclass($1) AS found', [month.name]);
  if (existing.rows[0]?.found !== null && existing.rows[0]?.found !== undefined) {
    return false;
  }
  await db.query(
    `CREATE TABLE ${month.name} (LIKE ${EVENTS} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS)`,
  );
  await db.query(
    `ALTER TABLE ${EVENTS} ATTACH PARTITION ${month.name} FOR VALUES FROM (${month.from}) TO (${month.to})`,
  );
  return true;
}

// How long a drop may wait for the table. Dropping a partition needs events
// to itself for an instant, so it queues behind any report that is reading,
// and everything that arrives while it waits queues behind it. A drop is only
// tidying (the month is already empty), so it gives up quickly and the next
// hourly pass tries again.
export const DROP_LOCK_TIMEOUT_MS = 500;

// Drop the months wholly older than an instant that hold no rows: what the
// retention purge leaves behind once every site's rows of a month are gone.
// Answers the names it dropped. A month that still holds a row of any site is
// never touched, and nothing here deletes a row.
export async function dropEmptyPartitionsBefore(pool: Pool, before: number): Promise<string[]> {
  const old = (await listPartitions(pool)).filter(
    // By name as well as by age: a table somebody attached to events under a
    // name of their own is theirs, and is not dropped here.
    (row) => row.to <= before && PARTITION_NAME.test(row.name),
  );
  if (old.length === 0) {
    return [];
  }
  const dropped: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${DROP_LOCK_TIMEOUT_MS}ms'`);
    await client.query(advisoryLockSql(LOCK_PARTITIONS));
    // The parent first and its months with it, the order an insert takes them
    // in, so a batch arriving now waits for this rather than deadlocking with
    // it; and held from before the look, so no row can land in a month between
    // finding it empty and dropping it.
    await client.query(`LOCK TABLE ${EVENTS} IN ACCESS EXCLUSIVE MODE`);
    for (const month of old) {
      const any = await client.query(`SELECT 1 FROM ${month.name} LIMIT 1`);
      if (any.rowCount === 0) {
        await client.query(`DROP TABLE ${month.name}`);
        dropped.push(month.name);
      }
    }
    await client.query('COMMIT');
    return dropped;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Somebody is reading: not an error, and nothing was dropped.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '55P03') {
      return [];
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface PartitionManager {
  // Make sure every month these instants fall in has a partition. Instants
  // outside the window are passed over. Answers the names it created.
  ensure(instants: readonly number[]): Promise<string[]>;
  // Forget what this process believes exists, so the next ensure asks the
  // database again. Called when an insert finds a month gone.
  forget(): void;
}

// What ingest holds. A process remembers the months it has seen, so the steady
// state is a lookup in a set and no round trip at all; a month it has not seen
// costs one transaction, once.
export function createPartitionManager(pool: Pool, now: () => number): PartitionManager {
  const known = new Set<string>();

  return {
    async ensure(instants: readonly number[]): Promise<string[]> {
      const wanted = monthsFor(instants, now()).filter((month) => !known.has(month.name));
      if (wanted.length === 0) {
        return [];
      }
      const created: string[] = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Two processes that meet a new month at the same moment take turns
        // here, and the second finds it made.
        await client.query(advisoryLockSql(LOCK_PARTITIONS));
        for (const month of wanted) {
          if (await createPartition(client, month)) {
            created.push(month.name);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      for (const month of wanted) {
        known.add(month.name);
      }
      return created;
    },

    forget(): void {
      known.clear();
    },
  };
}
