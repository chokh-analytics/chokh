import { VITAL_METRICS, vitalBucket, type VitalMetric } from '@chokh/store';
import { MongoClient, type Db, type Document } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  coveragePipeline,
  errorFacetsPipeline,
  errorMessagesPipeline,
  errorTotalsPipeline,
  vitalBucketExpression,
  vitalsPipeline,
} from './health.pipelines.js';
import { apply } from './migrate.js';
import { createMongoStore } from './mongo.store.js';

// AN-VIT01's MongoDB proof, three parts. The bucket a measurement falls in is
// computed by the pipeline exactly as vitalBucket computes it, over seeded and
// edge values; each read walks its index and never the collection, reading its
// own rows and no others, with the timing written down for the ticket; and the
// reads answer the same on a database migrate has not reached yet.

const DAY = 24 * 60 * 60 * 1000;
const SITE = 'site_health_scale';
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const VISITORS = 10_000;

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let store: Awaited<ReturnType<typeof createMongoStore>>;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function stageNames(explained: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'rejectedPlans' || key === 'allPlansExecution') continue;
      if (key === 'stage' && typeof value === 'string') found.push(value);
      walk(value);
    }
  };
  walk(explained);
  return found;
}

function indexNames(explained: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.indexName === 'string') found.add(record.indexName);
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'rejectedPlans' && key !== 'allPlansExecution') walk(value);
    }
  };
  walk(explained);
  return [...found].sort();
}

function examined(explained: unknown): { docs: number; keys: number } {
  let docs = 0;
  let keys = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.totalDocsExamined === 'number') docs = Math.max(docs, record.totalDocsExamined);
    if (typeof record.totalKeysExamined === 'number') keys = Math.max(keys, record.totalKeysExamined);
    Object.values(record).forEach(walk);
  };
  walk(explained);
  return { docs, keys };
}

const counts = { events: 0, vitals: 0, errors: 0, identified: 0 };
const month = { from: NOW - 30 * DAY, to: NOW };

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri('chokh_health'));
  await client.connect();
  store = await createMongoStore({ client, now: () => NOW });
  db = store.db;
  await apply(db);
  await store.createSite({
    id: SITE,
    name: SITE,
    domains: ['health.test'],
    settings: {
      ipMode: 'none',
      visitorIdMode: 'persistent',
      botFilter: true,
      retentionDays: 400,
      timezone: 'UTC',
      allowUnsignedIdentify: true,
      excludeIps: [],
      excludePaths: [],
      excludeQueryParams: [],
      routeGroups: [],
    },
  });

  // A month and a half of a busy site, written straight to the collection:
  // pageviews, three vitals a page, an error now and then, a tenth of the
  // people signed in and their server events.
  const next = random(11);
  const rows: Document[] = [];
  const pages = ['/', '/courses', '/courses/cp', '/pricing', '/blog/a', '/blog/b', '/contest'];
  const devices = ['desktop', 'mobile', 'tablet'];
  const browsers = ['Chrome', 'Safari', 'Firefox', 'Edge'];
  const messages = ['TypeError: a is undefined', 'ReferenceError: b', 'Script error.', 'NetworkError'];
  for (let index = 0; index < VISITORS; index += 1) {
    const visitorId = `v${index}`;
    const userId = index % 10 === 0 ? `u${index}` : undefined;
    const ua = { browser: browsers[index % browsers.length], device: devices[index % devices.length] };
    const views = 1 + Math.floor(next() * 6);
    for (let view = 0; view < views; view += 1) {
      const ts = NOW - Math.floor(next() * 45 * DAY);
      const path = pages[Math.floor(next() * pages.length)];
      const base = { siteId: SITE, visitorId, path, route: path, bot: false, ua, receivedAt: ts };
      const who = userId === undefined ? {} : { userId };
      rows.push({ ...base, ...who, ts, type: 'pageview' });
      rows.push({ ...base, ...who, ts: ts + 1, type: 'vital', name: 'LCP', value: 800 + next() * 4000 });
      rows.push({ ...base, ...who, ts: ts + 2, type: 'vital', name: 'CLS', value: next() * 0.4 });
      rows.push({ ...base, ...who, ts: ts + 3, type: 'vital', name: 'INP', value: 40 + next() * 600 });
      if (next() < 0.02) {
        rows.push({
          ...base,
          ...who,
          ts: ts + 4,
          type: 'error',
          name: messages[Math.floor(next() * messages.length)],
          frame: 'https://health.test/app.js:1:2',
        });
      }
      if (userId !== undefined && next() < 0.3) {
        rows.push({ siteId: SITE, visitorId: `u:${userId}`, userId, source: 'server', type: 'event', name: 'paid', ts: ts + 5, receivedAt: ts, bot: false });
      }
    }
  }
  for (const row of rows) {
    const ts = row.ts as number;
    if (ts < month.from || ts >= month.to) continue;
    counts.events += 1;
    if (row.type === 'vital') counts.vitals += 1;
    if (row.type === 'error') counts.errors += 1;
    if (row.userId !== undefined) counts.identified += 1;
  }
  await db.collection('events').insertMany(rows, { ordered: false });
}, 300_000);

afterAll(async () => {
  await client.close();
  await server.stop();
});

describe('the vital bucket in the pipeline', () => {
  it('is the bucket vitalBucket gives, for seeded and edge values of every metric', async () => {
    const next = random(3);
    const edges = [0, 0.1, 0.25, 0.1 + 0.2, 0.101, 0.0999, 2500, 2500.4, 2500.5, 2499.5, 4000, 4000.01, 600_000, 600_001, -0.001, 1e9];
    const docs: Document[] = [];
    for (const name of VITAL_METRICS) {
      for (const value of edges) docs.push({ name, value });
      for (let at = 0; at < 2000; at += 1) {
        docs.push({ name, value: name === 'CLS' ? next() * 1.5 : next() * 12_000 });
      }
    }
    docs.push({ name: 'LCP', value: Number.NaN });
    const scratch = db.collection('health_bucket_scratch');
    await scratch.insertMany(docs);
    const answered = await scratch
      .aggregate([{ $project: { _id: 0, name: 1, value: 1, q: vitalBucketExpression } }])
      .toArray();
    for (const row of answered) {
      expect([row.name, row.value, row.q]).toEqual([
        row.name,
        row.value,
        vitalBucket(row.name as VitalMetric, row.value as number),
      ]);
    }
    expect(answered).toHaveLength(docs.length);
    await scratch.drop();
  });
});

describe('health reads on a month of a busy site', () => {
  async function explain(pipeline: Document[]): Promise<Document> {
    return (await db
      .collection('events')
      .aggregate(pipeline, { allowDiskUse: true })
      .explain('executionStats')) as Document;
  }

  async function timed(read: () => Promise<unknown>): Promise<number> {
    const started = performance.now();
    await read();
    return Math.round(performance.now() - started);
  }

  function assertWalk(explained: Document, index: string): { docs: number; keys: number } {
    const stages = stageNames(explained);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
    expect(indexNames(explained)).toEqual([index]);
    return examined(explained);
  }

  const report: string[] = [];
  afterAll(() => {
    process.stdout.write(
      `health at ${VISITORS} visitors, ${counts.events} events in 30 days (${counts.vitals} vitals, ${counts.errors} errors, ${counts.identified} identified rows):\n  ${report.join('\n  ')}\n`,
    );
  });

  it('vitals walk event_site_type_ts and read the vitals of the range only', async () => {
    const explained = await explain(vitalsPipeline(SITE, month));
    const seen = assertWalk(explained, 'event_site_type_ts');
    expect(seen.docs).toBe(counts.vitals);
    const rows = await db.collection('events').aggregate(vitalsPipeline(SITE, month)).toArray();
    // One histogram per page, device and metric: 7 x 3 x 3.
    expect(rows.length).toBe(63);
    const ms = await timed(() => store.vitals({ siteId: SITE, ...month }));
    report.push(`vitals (30 days): docs ${seen.docs}, keys ${seen.keys}, ${rows.length} histograms back, ${ms} ms end to end`);
  });

  it('errors walk event_site_type_ts three times and read the errors of the range only', async () => {
    const reads = [
      errorMessagesPipeline(SITE, month, 50),
      errorTotalsPipeline(SITE, month),
      errorFacetsPipeline(SITE, month, ['TypeError: a is undefined', 'Script error.']),
    ];
    const seen = reads.map((pipeline) => explain(pipeline));
    for (const each of await Promise.all(seen)) {
      const walk = assertWalk(each, 'event_site_type_ts');
      expect(walk.docs).toBe(counts.errors);
      // The newest-first walk is the index's own order, never a SORT.
      expect(stageNames(each)).not.toContain('SORT');
    }
    const result = await store.errors({ siteId: SITE, ...month });
    expect(result.total).toBe(counts.errors);
    expect(result.groupsTotal).toBe(4);
    const ms = await timed(() => store.errors({ siteId: SITE, ...month }));
    report.push(`errors (30 days): docs ${counts.errors} per walk, 3 walks, ${ms} ms end to end`);
  });

  it('coverage walks event_site_user_ts over the identified rows only', async () => {
    const explained = await explain(coveragePipeline(SITE, month));
    const seen = assertWalk(explained, 'event_site_user_ts');
    expect(seen.docs).toBe(counts.identified);
    const result = await store.coverage({ siteId: SITE, ...month });
    expect(result.state).toBe('ok');
    const ms = await timed(() => store.coverage({ siteId: SITE, ...month }));
    report.push(
      `coverage (30 days): docs ${seen.docs}, keys ${seen.keys}, ${result.people} people, ${ms} ms end to end`,
    );
  });

  it('answers the same on a database migrate has not reached', async () => {
    const bare = await createMongoStore({ client, now: () => NOW, dbName: 'chokh_health_bare' });
    const site = await store.site(SITE);
    await bare.createSite(site!);
    const sample = await db
      .collection('events')
      .find({ siteId: SITE, ts: { $gte: NOW - 3 * DAY } }, { projection: { _id: 0 } })
      .toArray();
    await bare.db.collection('events').insertMany(sample);
    const range = { siteId: SITE, from: NOW - 3 * DAY, to: NOW };
    const before = [await bare.vitals(range), await bare.errors(range), await bare.coverage(range)];
    await apply(bare.db);
    const after = [await bare.vitals(range), await bare.errors(range), await bare.coverage(range)];
    expect(before).toEqual(after);
    expect(before[0]).toEqual(await store.vitals(range));
    await bare.db.dropDatabase();
  });
});
