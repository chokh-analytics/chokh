import { createMemoryPresence } from '@chokh/store';
import { fixture, runAccountConformance, runStoreConformance } from '@chokh/store/conformance';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

import { apply } from './migrate.js';
import { createMongoStore } from './mongo.store.js';

// Repository rule 5: every adapter passes the one conformance suite. This one
// runs against a real mongod, downloaded by mongodb-memory-server, so no
// machine and no CI runner needs Docker to prove the adapter.
runStoreConformance('mongodb', async () => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri('chokh_conformance'));
  await client.connect();
  // Presence is not storage, so it is handed in rather than found in MongoDB.
  // The suite runs it on the map, because which backend holds the live set is
  // the one thing an adapter has no say in.
  const presence = createMemoryPresence();
  const store = await createMongoStore({ client, presence, now: () => fixture.NOW });
  // Indexes come from the migration, never from the adapter, so the suite runs
  // against the database an operator would actually have.
  await apply(store.db);

  return {
    store,
    addSite: (site) => store.createSite(site),
    reset: async () => {
      for (const name of ['events', 'sessions', 'visitors', 'rollups_daily', 'sites']) {
        await store.db.collection(name).deleteMany({});
      }
      presence.clear();
    },
    close: async () => {
      await store.close();
      await client.close();
      await server.stop();
    },
  };
});

// The same for the control plane, against the same real mongod: the unique
// indexes on sites.domains, users.email and api_keys.keyHash are half of what
// these answers depend on, so they are proved where those indexes exist.
runAccountConformance('mongodb', async () => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri('chokh_accounts'));
  await client.connect();
  const store = await createMongoStore({ client, now: () => fixture.NOW });
  await apply(store.db);

  return {
    store,
    reset: async () => {
      for (const name of ['sites', 'users', 'teams', 'api_keys', 'audit_log', 'goals']) {
        await store.db.collection(name).deleteMany({});
      }
    },
    close: async () => {
      await store.close();
      await client.close();
      await server.stop();
    },
  };
});
