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
  conversionBreakdownPipeline,
  conversionTotalsPipeline,
  engagementPipeline,
  rawBreakdownPipeline,
  rawTotalsByBucketPipeline,
  rollupBreakdownPipeline,
  rollupTotalsByDatePipeline,
  sessionBreakdownPipeline,
  sessionConversionBreakdownPipeline,
  sessionSourcedBreakdownPipeline,
  sessionTotalsByBucketPipeline,
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

// The part of an explain that a $unionWith brings in, which has a plan of its
// own. A conversion read is two halves under one key, and a half that scans
// the collection is the whole events collection read on every goal read even
// when the other half leads with an index.
function unionStages(explained: Document): string[][] {
  const found: string[][] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$unionWith') {
        found.push(scanStages({ stages: value } as Document));
        continue;
      }
      walk(value);
    }
  };
  walk(explained);
  return found;
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri('chokh_explain'));
  await client.connect();
  const store = await createMongoStore({ client, now: () => fixture.NOW });
  db = store.db;
  await apply(db);
  await store.createSite(fixture.fixtureSite());
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

// The bucketed pipelines are what makes a time series one query per source rather
// than one per bucket, so they are on the same footing as the breakdowns: a series
// that falls back to a collection scan is worse than the round trips it replaced.
describe('bucketed series pipelines', () => {
  const span = { from: fixture.DAY_BEFORE_START, to: fixture.NOW };

  async function explain(collection: string, pipeline: Document[]): Promise<string[]> {
    const explained = (await db
      .collection(collection)
      .aggregate(pipeline)
      .explain('queryPlanner')) as unknown as Document;
    return scanStages(explained);
  }

  it.each(['minute', 'hour', 'day'] as const)(
    'scans an index for raw totals by %s',
    async (interval) => {
      const stages = await explain(
        'events',
        rawTotalsByBucketPipeline(
          fixture.SITE_ID,
          span,
          fixture.TIMEZONE,
          interval,
          false,
          undefined,
        ),
      );
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
    },
  );

  it.each(['hour', 'day'] as const)('scans an index for session totals by %s', async (interval) => {
    const stages = await explain(
      'sessions',
      sessionTotalsByBucketPipeline(
        fixture.SITE_ID,
        span,
        fixture.TIMEZONE,
        interval,
        false,
        undefined,
      ),
    );
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });

  // The new dimension of AN-PAG01 reads its history the same way every other
  // rolled dimension does, so the one thing worth proving separately is that
  // the rollup read still leads with an index now that the key space is wider.
  it('scans an index for a rollup breakdown by status', async () => {
    await (await createMongoStore({ client, now: () => fixture.NOW })).rollupDay(
      fixture.SITE_ID,
      fixture.YESTERDAY,
    );
    const stages = await explain(
      'rollups_daily',
      rollupBreakdownPipeline(fixture.SITE_ID, [fixture.DAY_BEFORE, fixture.YESTERDAY], 'status'),
    );
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });

  it('scans an index for rollup totals by date', async () => {
    await (await createMongoStore({ client, now: () => fixture.NOW })).rollupDay(
      fixture.SITE_ID,
      fixture.DAY_BEFORE,
    );
    const stages = await explain(
      'rollups_daily',
      rollupTotalsByDatePipeline(fixture.SITE_ID, [fixture.DAY_BEFORE, fixture.YESTERDAY], 'total', ''),
    );
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });
});

// The engagement read is raw rows only and has no rollup to fall back on, so a
// collection scan here is not a slow report, it is the whole events collection
// read on every load of the Pages page.
describe('engagement pipeline', () => {
  it.each(['page', 'country', 'device'] as const)(
    'scans an index for leave beacons by %s',
    async (dim) => {
      const explained = (await db
        .collection('events')
        .aggregate(
          engagementPipeline(
            fixture.SITE_ID,
            { from: fixture.DAY_BEFORE_START, to: fixture.NOW },
            dim,
            false,
            undefined,
          ),
        )
        .explain('queryPlanner')) as unknown as Document;
      const stages = scanStages(explained);
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
    },
  );
});

// A goal read is raw for its whole range, so it has no rollup to fall back on:
// both halves of it have to lead with an index or a conversion column is a
// collection scan per card.
describe('conversion pipelines', () => {
  const span = { from: fixture.DAY_BEFORE_START, to: fixture.NOW };
  const goals = [
    { kind: 'event', match: fixture.SIGNUP },
    { kind: 'page', match: '/pricing' },
    { kind: 'page', match: '/*/pricing' },
  ] as const;

  async function explain(collection: string, pipeline: Document[]): Promise<Document> {
    return (await db
      .collection(collection)
      .aggregate(pipeline)
      .explain('queryPlanner')) as unknown as Document;
  }

  // The outer half is the first stage, the $cursor MongoDB read the collection
  // with; the inner half is the plan inside the $unionWith stage. Read apart,
  // so an index on one half cannot pass for the other. Only the plan's stages
  // are walked: the explain also echoes the command, whose $unionWith carries
  // no plan at all.
  function expectIndexed(explained: Document): void {
    const stages = explained.stages as Document[];
    const outer = scanStages({ stages: stages[0] } as Document);
    expect(outer).toContain('IXSCAN');
    expect(outer).not.toContain('COLLSCAN');
    const unions = unionStages({ stages } as Document);
    expect(unions).toHaveLength(1);
    for (const inner of unions) {
      expect(inner).toContain('IXSCAN');
      expect(inner).not.toContain('COLLSCAN');
    }
  }

  it.each(goals)('scans an index on both halves of the totals for a $kind goal', async (goal) => {
    expectIndexed(
      await explain(
        'events',
        conversionTotalsPipeline(fixture.SITE_ID, span, fixture.TIMEZONE, false, undefined, goal),
      ),
    );
  });

  it.each(['country', 'page', 'utm_campaign', 'event'] as const)(
    'scans an index on both halves of a breakdown by %s',
    async (dim) => {
      expectIndexed(
        await explain(
          'events',
          conversionBreakdownPipeline(
            fixture.SITE_ID,
            span,
            fixture.TIMEZONE,
            dim,
            false,
            undefined,
            goals[0],
          ),
        ),
      );
    },
  );

  it.each(SESSION_DIMENSIONS)(
    'scans an index on both halves of a breakdown by %s off the stays',
    async (dim) => {
      expectIndexed(
        await explain(
          'sessions',
          sessionConversionBreakdownPipeline(
            fixture.SITE_ID,
            span,
            fixture.TIMEZONE,
            dim,
            false,
            undefined,
            goals[0],
          ),
        ),
      );
    },
  );
});

describe('the adapter never creates an index', () => {
  it('leaves a fresh database with nothing but _id until migrate runs', async () => {
    const bare = client.db('chokh_no_auto_index');
    const store = await createMongoStore({ client, dbName: 'chokh_no_auto_index' });
    await store.createSite(fixture.fixtureSite());
    await store.ingest(fixture.fixtureEvents());
    await store.rollupDay(fixture.SITE_ID, fixture.DAY_BEFORE);

    for (const name of ['events', 'sites', 'sessions', 'visitors', 'rollups_daily']) {
      const indexes = await bare.collection(name).listIndexes().toArray();
      expect(indexes.map((index) => index.name)).toEqual(['_id_']);
    }
  });
});
