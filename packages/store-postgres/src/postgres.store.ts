import {
  createMemoryPresence,
  type AccountStore,
  type AnalyticsStore,
  type Presence,
  type StoreOptions,
} from '@chokh/store';
import type { Pool } from 'pg';

import { createAccounts } from './accounts.js';
import { DEFAULT_STATEMENT_TIMEOUT_MS, openPool } from './db.js';
import { createIngest } from './ingest.js';
import { verify } from './migrate.js';
import { createPartitionManager } from './partitions.js';
import { createPeople } from './people.js';
import { createReports } from './reports.js';
import { createRollup } from './rollup.js';
import { PostgresSetupError, assertSupported } from './server.js';
import { createSites } from './sites.js';

// The PostgreSQL adapter.
//
// It is being built in parts (AN-STO02). What is here is the whole of
// AccountStore and, of AnalyticsStore, the write path and the reads named in
// PostgresStore below. Funnels, journeys, retention, health, the route regroup
// and the purge follow, and the one conformance suite is wired with them: its
// reporting half seeds one world and cannot pass by halves. Until then nothing
// in the server can select this adapter.

export interface PostgresStoreOptions extends StoreOptions {
  // postgres:// or postgresql://. TLS is the URL's business (sslmode).
  url: string;
  // How many connections this process may hold. Ten when not given.
  poolSize?: number;
  // How long one statement may run before the server cancels it. Thirty
  // seconds when not given; the long jobs lift it for themselves.
  statementTimeoutMs?: number;
  // Told when the server drops a connection nobody was using (a restart, a
  // failover). The pool has already replaced it; this is only so a host can
  // log that it happened.
  onIdleError?: (error: Error) => void;
  // Told how many rows of a batch were not stored because their instant is
  // outside the window a partition may exist for: older than the longest
  // retention a site can have, or later than the month after this one. Neither
  // route that writes can send such a row, so a host that hears this is being
  // handed rows by something else.
  onOutsideWindow?: (count: number) => void;
}

export interface PostgresStore
  extends AccountStore,
    Pick<
      AnalyticsStore,
      | 'site'
      | 'sites'
      | 'ingest'
      | 'aggregate'
      | 'timeseries'
      | 'breakdown'
      | 'engagement'
      | 'events'
      | 'properties'
      | 'goalStats'
      | 'realtime'
      | 'visitor'
      | 'user'
      | 'visitorIdForUser'
      | 'people'
      | 'rollupDay'
      | 'close'
    > {
  // The adapter's own pool, for the tests that prove a plan and for a host
  // that wants to check the connection it was given.
  pool: Pool;
  // The server's version, read once when the store opened, for the boot log.
  serverVersion: string;
  // How many rows ingest has passed over since the store opened because no
  // partition may exist for their instant.
  readonly outsideWindow: number;
}

export async function createPostgresStore(options: PostgresStoreOptions): Promise<PostgresStore> {
  const pool = openPool({
    url: options.url,
    ...(options.poolSize === undefined ? {} : { poolSize: options.poolSize }),
    ...(options.statementTimeoutMs === undefined
      ? {}
      : { statementTimeoutMs: options.statementTimeoutMs }),
    ...(options.onIdleError === undefined ? {} : { onIdleError: options.onIdleError }),
  });
  let serverVersion: string;
  try {
    // The same report `migrate --verify-only` prints. A database the
    // migration has not reached has no tables to query, so every request
    // would fail one by one; refusing here says why once, with the command
    // that fixes it. Nothing is created: only migrate does that.
    const report = await verify(pool);
    assertSupported(report.server);
    if (report.missing > 0) {
      const { database, schema } = report.server;
      throw new PostgresSetupError(
        'NOT_MIGRATED',
        `The database "${database}" (schema ${schema}) is missing ${report.missing} of the tables, columns and indexes Chokh declares. Run: node packages/store-postgres/dist/migrate.js --apply`,
      );
    }
    serverVersion = report.server.version;
  } catch (error) {
    await pool.end();
    throw error;
  }

  const now = options.now ?? ((): number => Date.now());
  // Where ingest writes who is live and realtime reads it back. Not storage,
  // so it is handed in (Redis when a deployment has one) and is a map in this
  // process when it is not.
  const presence: Presence = options.presence ?? createMemoryPresence();
  const sites = createSites(pool, now);
  const accounts = createAccounts(pool, sites);
  let outsideWindow = 0;
  const ingest = createIngest({
    pool,
    sites,
    partitions: createPartitionManager(pool, now),
    presence,
    now,
    onOutsideWindow: (count) => {
      outsideWindow += count;
      options.onOutsideWindow?.(count);
    },
  });

  return {
    pool,
    serverVersion,
    get outsideWindow(): number {
      return outsideWindow;
    },
    ...accounts,
    ...createReports({ pool, sites, now }),
    ...createPeople({ pool, sites, presence, now }),
    ...createRollup({ pool, sites }),
    ingest,

    site: (siteId) => sites.site(siteId),
    sites: () => sites.sites(),
    siteByShareToken: (token) => sites.siteByShareToken(token),
    createSite: (site) => sites.createSite(site),
    updateSite: (siteId, patch) => sites.updateSite(siteId, patch),

    // Ends the pool. A statement already running is allowed to finish and its
    // connection is closed when it does, so a shutdown in the middle of a
    // write does not cut the write in half; a call made after this is refused.
    //
    // The wait before it is for the callers still queued for a connection. The
    // pool stops serving its queue the moment it is told to end and never
    // answers whoever was in it, so a request that had asked and not yet been
    // given a connection would hang for ever, and a shutdown with it. They are
    // let through first, for as long as a statement may run.
    async close(): Promise<void> {
      const patience = Date.now() + (options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS);
      while (pool.waitingCount > 0 && Date.now() < patience) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (options.presence === undefined) {
        await presence.close();
      }
      await pool.end();
    },
  };
}
