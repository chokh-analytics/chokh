import { createMongoStore } from '@chokh/store-mongo';

import { env } from '../config/env.js';
import type { AccountStore, AnalyticsStore, Presence } from '../store/AnalyticsStore.js';
import { createMemoryStore } from '../store/memory.store.js';

// Which adapter a deployment runs on. A MONGODB_URI means MongoDB; without one
// the install runs on memory and keeps nothing across a restart, which is
// enough to try the tracker on a laptop and never enough for a deployment.
//
// The indexes are not created here on purpose. `chokh-migrate --apply` owns
// them, so a process that boots can never quietly build an index on a live
// collection.
export async function openStore(presence: Presence): Promise<{
  // Both contracts, because one deployment has one database: the reports come
  // from AnalyticsStore and the accounts, teams, keys and audit log from
  // AccountStore, and every adapter implements both.
  store: AnalyticsStore & AccountStore;
  kind: string;
  // The database server's version, for the boot log: the property breakdown
  // needs MongoDB 5.0, and an operator on an older server should read why in
  // the first lines the process writes. Absent on memory, which has no server.
  version?: string;
}> {
  if (env.MONGODB_URI === undefined) {
    return { store: createMemoryStore([], { presence }), kind: 'memory' };
  }
  const store = await createMongoStore({ uri: env.MONGODB_URI, presence });
  return { store, kind: 'mongodb', version: store.serverVersion };
}
