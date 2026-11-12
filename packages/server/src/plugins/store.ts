import { createMongoStore } from '@chokh/store-mongo';
import { createPostgresStore } from '@chokh/store-postgres';

import { env } from '../config/env.js';
import type { AccountStore, AnalyticsStore, Presence } from '../store/AnalyticsStore.js';
import { createMemoryStore } from '../store/memory.store.js';

// Which adapter a deployment runs on. A DATABASE_URL means PostgreSQL and a
// MONGODB_URI means MongoDB; the environment has already refused both at once.
// Without either the install runs on memory and keeps nothing across a restart,
// which is enough to try the tracker on a laptop and is refused in production.
//
// Nothing is created here on purpose. Each adapter has one command that owns
// its indexes (and, for PostgreSQL, its tables), so a process that boots can
// never quietly build an index on a live table. MongoDB works without them,
// slowly; PostgreSQL has no tables to query until the migration has run, so
// that adapter refuses to open and says which command to run.

// What the store wants to say about itself while it runs, before and after
// there is a logger to say it to: the adapter is opened first, because the app
// is built around it.
export interface StoreLog {
  warn(details: object, message: string): void;
}

export interface LateLog extends StoreLog {
  // Hand over the real logger; whatever was said before it existed is said now.
  use(log: StoreLog): void;
}

export function createLateLog(): LateLog {
  let target: StoreLog | undefined;
  const waiting: [object, string][] = [];
  return {
    warn(details, message) {
      if (target === undefined) {
        waiting.push([details, message]);
      } else {
        target.warn(details, message);
      }
    },
    use(log) {
      target = log;
      for (const [details, message] of waiting.splice(0)) {
        log.warn(details, message);
      }
    },
  };
}

export async function openStore(
  presence: Presence,
  log: StoreLog = { warn: () => undefined },
): Promise<{
  // Both contracts, because one deployment has one database: the reports come
  // from AnalyticsStore and the accounts, teams, keys and audit log from
  // AccountStore, and every adapter implements both.
  store: AnalyticsStore & AccountStore;
  kind: string;
  // The database server's version, for the boot log: an operator on a server
  // too old for an adapter should read why in the first lines the process
  // writes. Absent on memory, which has no server.
  version?: string;
}> {
  if (env.DATABASE_URL !== undefined) {
    const store = await createPostgresStore({
      url: env.DATABASE_URL,
      presence,
      ...(env.DATABASE_POOL_SIZE === undefined ? {} : { poolSize: env.DATABASE_POOL_SIZE }),
      ...(env.DATABASE_STATEMENT_TIMEOUT_MS === undefined
        ? {}
        : { statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS }),
      // A restart or a failover of the database closes the connections the
      // pool was holding. The pool replaces them; this is so it is on record.
      onIdleError: (error) => log.warn({ err: error }, 'the database dropped an idle connection'),
      onOutsideWindow: (count) =>
        log.warn(
          { rows: count },
          'rows were not stored: their time is older than any retention or later than next month',
        ),
    });
    return { store, kind: 'postgres', version: store.serverVersion };
  }
  if (env.MONGODB_URI !== undefined) {
    const store = await createMongoStore({ uri: env.MONGODB_URI, presence });
    return { store, kind: 'mongodb', version: store.serverVersion };
  }
  return { store: createMemoryStore([], { presence }), kind: 'memory' };
}
