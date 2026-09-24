import { createMemoryPresence } from '@chokh/store';
import { fixture, runAccountConformance, runStoreConformance } from '@chokh/store/conformance';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';

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
    updateSite: (siteId, patch) => store.updateSite(siteId, patch),
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
      for (const name of [
        'sites',
        'users',
        'teams',
        'api_keys',
        'audit_log',
        'goals',
        'funnels',
        'segments',
        'annotations',
        'alerts',
      ]) {
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

// A site document written before a setting existed. The adapter reads the
// missing ones as their defaults rather than as undefined, and the document
// wins for the ones it has.
describe('a site document from before a setting existed', () => {
  it('reads the missing settings as their defaults, the document winning', async () => {
    const server = await MongoMemoryServer.create();
    const client = new MongoClient(server.getUri('chokh_legacy'));
    await client.connect();
    const store = await createMongoStore({ client, now: () => fixture.NOW });
    try {
      await apply(store.db);
      await store.db.collection('sites').insertOne({
        id: 's_old',
        name: 'Old',
        domains: ['old.example'],
        settings: {
          ipMode: 'full',
          visitorIdMode: 'persistent',
          botFilter: true,
          retentionDays: 30,
          timezone: 'Asia/Dhaka',
          allowUnsignedIdentify: false,
        },
      });
      const site = await store.site('s_old');
      expect(site?.settings.timezone).toBe('Asia/Dhaka');
      expect(site?.settings.ipMode).toBe('full');
      expect(site?.settings.allowUnsignedIdentify).toBe(false);
      expect(site?.settings.excludeIps).toEqual([]);
      expect(site?.settings.excludePaths).toEqual([]);
      expect(site?.settings.excludeQueryParams).toEqual([]);
      expect(site?.settings.routeGroups).toEqual([]);
      expect(site?.routesChangedAt).toBeUndefined();
    } finally {
      await store.close();
      await client.close();
      await server.stop();
    }
  });
});
