import type { AnalyticsStore, PurgeSummary } from '@chokh/store';
import type { Pool } from 'pg';

import { transaction } from './db.js';
import { dropEmptyPartitionsBefore, type PartitionManager } from './partitions.js';
import { NO_STATEMENT_TIMEOUT } from './rollup.js';
import { EVENTS, SESSIONS, VISITORS } from './schema.js';

// Retention. PostgreSQL has no expiry on a row, so this is the only thing that
// removes one: the hourly job calls it for every site with the instant that
// site's retention ends at.
//
// It is a delete and then a drop, in that order and for that reason. Retention
// is per site and a month's partition holds every site's rows, so a partition
// can never be dropped to expire one site; the site's rows are deleted, which
// is exact and is the count the contract answers, and a month is dropped once
// the deletes of every site have emptied it. The drop is what gives the disk
// back at once.

export type Purge = Pick<AnalyticsStore, 'purge'>;

export interface PurgeDeps {
  pool: Pool;
  partitions: PartitionManager;
}

// The three deletes. The first prunes to the months that end before the
// instant or straddle it, and walks (site_id, ts) in each; the other two walk
// (site_id, last_seen_at). The daily rollups are not touched, which is how
// history outlives the detail.
export const PURGE_EVENTS_SQL = `DELETE FROM ${EVENTS} WHERE site_id = $1 AND ts < $2`;
export const PURGE_SESSIONS_SQL = `DELETE FROM ${SESSIONS} WHERE site_id = $1 AND last_seen_at < $2`;
export const PURGE_VISITORS_SQL = `DELETE FROM ${VISITORS} WHERE site_id = $1 AND last_seen_at < $2`;

export function createPurge(deps: PurgeDeps): Purge {
  const { pool, partitions } = deps;

  return {
    async purge(siteId: string, before: number): Promise<PurgeSummary> {
      // One transaction, so a purge that is interrupted has deleted nothing:
      // a stay is never left without its events, or the other way about.
      const summary = await transaction(pool, async (db) => {
        await db.query(NO_STATEMENT_TIMEOUT);
        const events = await db.query(PURGE_EVENTS_SQL, [siteId, before]);
        const sessions = await db.query(PURGE_SESSIONS_SQL, [siteId, before]);
        const visitors = await db.query(PURGE_VISITORS_SQL, [siteId, before]);
        return {
          events: events.rowCount ?? 0,
          sessions: sessions.rowCount ?? 0,
          visitors: visitors.rowCount ?? 0,
        };
      });
      // Tidying, after the answer is settled: whatever it finds or fails to
      // lock changes nothing about what was purged.
      const dropped = await dropEmptyPartitionsBefore(pool, before);
      if (dropped.length > 0) {
        partitions.forget();
      }
      return summary;
    },
  };
}
