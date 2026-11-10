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
        'digests',
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

// AN-ING01: a batch from one visitor costs four round trips once the site row
// is cached: one aggregation for the visitor and their open stay, then the
// events, the stays and the visitor written together. A second read creeping
// back in would make it five, and this is what notices.
describe('the round trips an ingest costs', () => {
  it('is one read and three writes for a visitor, with the site cached', async () => {
    const server = await MongoMemoryServer.create();
    const client = new MongoClient(server.getUri('chokh_trips'), { monitorCommands: true });
    await client.connect();
    const store = await createMongoStore({ client, now: () => fixture.NOW });
    const sent: string[] = [];
    client.on('commandStarted', (event) => sent.push(event.commandName));
    try {
      await apply(store.db);
      await store.createSite(fixture.fixtureSite());
      // Plain pageviews, so no identify adds the merge's two writes.
      sent.length = 0;
      await store.ingest([fixture.pageviewOf('v2', fixture.NOW - 60_000, '/a')]);
      // The first batch reads the site row too, and fills the cache.
      expect([...sent].sort()).toEqual(['aggregate', 'find', 'insert', 'update', 'update']);

      // A returning visitor with an open stay: the read finds both.
      sent.length = 0;
      await store.ingest([fixture.pageviewOf('v2', fixture.NOW - 30_000, '/b')]);
      expect([...sent].sort()).toEqual(['aggregate', 'insert', 'update', 'update']);
      // And it found the stay: the second pageview joined it rather than
      // opening another.
      expect(await store.db.collection('sessions').countDocuments({ visitorId: 'v2' })).toBe(1);
    } finally {
      await store.close();
      await client.close();
      await server.stop();
    }
  });
});
