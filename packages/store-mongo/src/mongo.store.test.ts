import { createMemoryPresence } from '@chokh/store';
import { fixture, runStoreConformance } from '@chokh/store/conformance';
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
    addSite: (site) => store.addSite(site),
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
