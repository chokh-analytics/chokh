import type { AccountStore, AnalyticsStore, StoreOptions } from '@chokh/store';
import type { Pool } from 'pg';

import { createAccounts } from './accounts.js';
import { openPool } from './db.js';
import { verify } from './migrate.js';
import { PostgresSetupError, assertSupported } from './server.js';
import { createSites } from './sites.js';

// The PostgreSQL adapter.
//
// It is being built in parts (AN-STO02). What is here is the control plane:
// the whole of AccountStore and, from the reporting side, the two reads of a
// site that the account side cannot be proved without. The rest of
// AnalyticsStore follows, and until it does nothing in the server can select
// this adapter.

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
}

export interface PostgresStore
  extends AccountStore,
    Pick<AnalyticsStore, 'site' | 'sites' | 'close'> {
  // The adapter's own pool, for the tests that prove a plan and for a host
  // that wants to check the connection it was given.
  pool: Pool;
  // The server's version, read once when the store opened, for the boot log.
  serverVersion: string;
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
  const sites = createSites(pool, now);
  const accounts = createAccounts(pool, sites);

  return {
    pool,
    serverVersion,
    ...accounts,

    site: (siteId) => sites.site(siteId),
    sites: () => sites.sites(),
    siteByShareToken: (token) => sites.siteByShareToken(token),
    createSite: (site) => sites.createSite(site),
    updateSite: (siteId, patch) => sites.updateSite(siteId, patch),

    // Ends the pool. A statement already running is allowed to finish and its
    // connection is closed when it does, so a shutdown in the middle of a
    // write does not cut the write in half; a call made after this is refused.
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
