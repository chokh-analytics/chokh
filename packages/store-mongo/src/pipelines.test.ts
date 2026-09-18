import {
  DIMENSIONS,
  SESSION_DIMENSIONS,
  SESSION_PATH_BY_DIMENSION,
  type Dimension,
} from '@chokh/store';
import { fixture } from '@chokh/store/conformance';
import { MongoClient, type Db, type Document } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apply } from './migrate.js';
import { createMongoStore } from './mongo.store.js';
import {
  rawBreakdownPipeline,
  sessionBreakdownPipeline,
  sessionSourcedBreakdownPipeline,
} from './pipelines.js';

// The ticket's second verify line: an explain on each breakdown pipeline
// showing an index scan. A breakdown that falls back to a collection scan is
// the difference between a dashboard and a stalled cluster, and the fixture is
// seeded first because MongoDB will happily scan an empty collection.

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

const EXPLAINABLE: Dimension[] = DIMENSIONS.filter((dim) => !SESSION_DIMENSIONS.includes(dim));

// Everything a stay can be broken down by, which is every dimension except the
// four a stay spans rather than has.
const SESSION_EXPLAINABLE: Dimension[] = DIMENSIONS.filter(
  (dim) => SESSION_PATH_BY_DIMENSION[dim] !== undefined,
);

// The winning plan sits under queryPlanner for a simple read and under the
// first $cursor stage for an aggregation, depending on the server version.
function scanStages(explained: Document): string[] {
  const stages: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'stage' && typeof value === 'string') {
        stages.push(value);
      }
      walk(value);
    }
  };
  walk(explained.queryPlanner ?? explained.stages ?? explained);
  return stages;
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri('chokh_explain'));
  await client.connect();
  const store = await createMongoStore({ client, now: () => fixture.NOW });
  db = store.db;
  await apply(db);
  await store.addSite(fixture.fixtureSite());
  await store.ingest(fixture.fixtureEvents());
}, 120_000);

afterAll(async () => {
  await client.close();
  await server.stop();
});

describe('breakdown pipelines', () => {
  it.each(EXPLAINABLE)('scans an index for %s', async (dim) => {
    const pipeline = rawBreakdownPipeline(
      fixture.SITE_ID,
      { from: fixture.DAY_BEFORE_START, to: fixture.NOW },
      fixture.TIMEZONE,
      dim,
      false,
      undefined,
    );
    const explained = (await db
      .collection('events')
      .aggregate(pipeline)
      .explain('queryPlanner')) as unknown as Document;
    const stages = scanStages(explained);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });
});

describe('session pipelines', () => {
  it.each(SESSION_EXPLAINABLE)('scans an index for %s', async (dim) => {
    const span = { from: fixture.DAY_BEFORE_START, to: fixture.NOW };
    const pipeline = SESSION_DIMENSIONS.includes(dim)
      ? sessionSourcedBreakdownPipeline(
          fixture.SITE_ID,
          span,
          fixture.TIMEZONE,
          dim,
          false,
          undefined,
        )
      : sessionBreakdownPipeline(fixture.SITE_ID, span, dim, false, undefined);
    const explained = (await db
      .collection('sessions')
      .aggregate(pipeline)
      .explain('queryPlanner')) as unknown as Document;
    const stages = scanStages(explained);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });
});

describe('the adapter never creates an index', () => {
  it('leaves a fresh database with nothing but _id until migrate runs', async () => {
    const bare = client.db('chokh_no_auto_index');
    const store = await createMongoStore({ client, dbName: 'chokh_no_auto_index' });
    await store.addSite(fixture.fixtureSite());
    await store.ingest(fixture.fixtureEvents());
    await store.rollupDay(fixture.SITE_ID, fixture.DAY_BEFORE);

    for (const name of ['events', 'sites', 'sessions', 'visitors', 'rollups_daily']) {
      const indexes = await bare.collection(name).listIndexes().toArray();
      expect(indexes.map((index) => index.name)).toEqual(['_id_']);
    }
  });
});
