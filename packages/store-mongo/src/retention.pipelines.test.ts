import {
  ACTIVITY_WINDOWS,
  activityPlan,
  addVisitorDays,
  cohortPlan,
  emptyActivityTally,
  powerMinDays,
  type VisitorDays,
} from '@chokh/store';
import { MongoClient, type Db, type Document } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apply } from './migrate.js';
import { activityTallyFrom, createMongoStore } from './mongo.store.js';
import {
  activityDayStages,
  activityFoldStages,
  attributionConvertersPipeline,
  attributionLookups,
  cohortPipeline,
  powerUsersPipeline,
} from './retention.pipelines.js';

// AN-PPL01's MongoDB proof, three parts. The fold the activity read does inside
// the pipeline is run against addVisitorDays over seeded visitors and must give
// the same tally; each read's plan walks an index and never the collection; and
// at 20,000 visitors each read examines the range's rows once, not once per
// person, with the timing written down for the ticket.

const DAY = 24 * 60 * 60 * 1000;
const SITE = 'site_scale';
const TIMEZONE = 'Asia/Dhaka';
// Frozen like the conformance clock: Friday 18 September 2026, 10:00 in Dhaka.
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const VISITORS = 20_000;

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let store: Awaited<ReturnType<typeof createMongoStore>>;

// A small deterministic generator, so a failure names a seed that reproduces.
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
    if (Array.isArray(record.indexesUsed)) {
      for (const name of record.indexesUsed) if (typeof name === 'string') found.add(name);
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'rejectedPlans' && key !== 'allPlansExecution') walk(value);
    }
  };
  walk(explained);
  return [...found].sort();
}

// The largest docsExamined and keysExamined anywhere in an explain.
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

let stays = 0;
let staysIn90 = 0;
let goalRows = 0;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri('chokh_retention'));
  await client.connect();
  store = await createMongoStore({ client, now: () => NOW });
  db = store.db;
  await apply(db);
  await store.createSite({
    id: SITE,
    name: SITE,
    domains: ['scale.test'],
    settings: {
      ipMode: 'none',
      visitorIdMode: 'persistent',
      botFilter: true,
      retentionDays: 400,
      timezone: TIMEZONE,
      allowUnsignedIdentify: true,
      excludeIps: [],
      excludePaths: [],
      excludeQueryParams: [],
      routeGroups: [],
    },
  });

  // Written straight to the collections rather than through ingest: 20,000
  // people and their stays are the shape of a busy site's last four months,
  // and the reads only care what the rows say.
  const next = random(42);
  const sessionRows: Document[] = [];
  const visitorRows: Document[] = [];
  const eventRows: Document[] = [];
  const channels = ['direct', 'organic', 'social', 'email', 'paid', 'referral'];
  for (let index = 0; index < VISITORS; index += 1) {
    const id = `v${String(index).padStart(5, '0')}`;
    const first = NOW - Math.floor(next() * 120 * DAY);
    const count = 1 + Math.floor(next() * next() * 12);
    const starts = [first];
    for (let more = 1; more < count; more += 1) {
      starts.push(first + Math.floor(next() * (NOW - first)));
    }
    starts.sort((left, right) => left - right);
    starts.forEach((startedAt, at) => {
      const sessionId = `${id}_${at}`;
      sessionRows.push({
        siteId: SITE,
        id: sessionId,
        visitorId: id,
        startedAt,
        lastSeenAt: startedAt + 60_000,
        pageviews: 2,
        events: 0,
        duration: 60_000,
        bot: false,
        isNew: at === 0,
        channel: channels[Math.floor(next() * channels.length)],
        entryPath: '/',
      });
      // Three pageviews a stay, so the events collection is the size a goal
      // read has to walk past.
      for (let view = 0; view < 3; view += 1) {
        eventRows.push({
          siteId: SITE,
          ts: startedAt + view * 1000,
          receivedAt: startedAt,
          type: 'pageview',
          visitorId: id,
          sessionId,
          path: '/',
          bot: false,
        });
      }
      if (next() < 0.05) {
        eventRows.push({
          siteId: SITE,
          ts: startedAt + 5000,
          receivedAt: startedAt,
          type: 'event',
          name: 'signup',
          visitorId: id,
          sessionId,
          bot: false,
        });
      }
    });
    visitorRows.push({
      siteId: SITE,
      id,
      firstSeenAt: starts[0],
      lastSeenAt: starts[starts.length - 1],
      sessions: count,
      pageviews: count * 2,
      devices: [],
      ips: [],
      places: [],
      firstTouch: { at: first, channel: channels[index % channels.length] },
    });
  }
  stays = sessionRows.length;
  staysIn90 = sessionRows.filter((row) => (row.startedAt as number) >= NOW - 120 * DAY).length;
  goalRows = eventRows.filter((row) => row.type === 'event').length;
  await db.collection('sessions').insertMany(sessionRows, { ordered: false });
  await db.collection('visitors').insertMany(visitorRows, { ordered: false });
  await db.collection('events').insertMany(eventRows, { ordered: false });
}, 300_000);

afterAll(async () => {
  await client.close();
  await server.stop();
});


describe('the activity fold in the pipeline', () => {
  it('gives the tally addVisitorDays gives, over 2,000 seeded visitors', async () => {
    const plan = activityPlan({ siteId: SITE, from: NOW - 60 * DAY, to: NOW }, TIMEZONE);
    const spanDays = plan.starts.length;
    const next = random(7);
    const seeded: VisitorDays[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const days = new Set<number>();
      const count = 1 + Math.floor(next() * 10);
      for (let pick = 0; pick < count; pick += 1) days.add(Math.floor(next() * spanDays));
      const sorted = [...days].sort((left, right) => left - right);
      const roll = next();
      const first = roll < 0.3 ? null : roll < 0.8 ? sorted[0]! : sorted[sorted.length - 1]!;
      seeded.push({ days: sorted, first });
    }
    const scratch = db.collection('retention_fold_scratch');
    await scratch.deleteMany({});
    await scratch.insertMany(seeded.map((visitor) => ({ ...visitor })));

    const rows = await scratch
      .aggregate(activityFoldStages(plan.offset, ACTIVITY_WINDOWS), { allowDiskUse: true })
      .toArray();
    const fromPipeline = activityTallyFrom(rows, spanDays, plan.offset, plan.days);

    const expected = emptyActivityTally(plan.days);
    for (const visitor of seeded) addVisitorDays(expected, plan, visitor);
    expect(fromPipeline).toEqual(expected);
    await scratch.drop();
  });
});

describe('retention reads at 20,000 visitors', () => {
  async function explain(collection: string, pipeline: Document[]): Promise<Document> {
    return (await db
      .collection(collection)
      .aggregate(pipeline, { allowDiskUse: true })
      .explain('executionStats')) as Document;
  }

  async function timed(collection: string, pipeline: Document[]): Promise<number> {
    const started = performance.now();
    await db.collection(collection).aggregate(pipeline, { allowDiskUse: true }).toArray();
    return Math.round(performance.now() - started);
  }

  const report: string[] = [];
  afterAll(() => {
    // The numbers the ticket's shipped note quotes.
    process.stdout.write(
      `retention at ${VISITORS} visitors, ${stays} stays, ${goalRows} goal rows:\n  ${report.join('\n  ')}\n`,
    );
  });

  it('cohorts walk session_site_started once', async () => {
    const plan = cohortPlan({ siteId: SITE, from: NOW - 12 * 7 * DAY, to: NOW, interval: 'week' }, TIMEZONE);
    const pipeline = cohortPipeline(SITE, plan.span, TIMEZONE, 'week');
    const explained = await explain('sessions', pipeline);
    const stages = stageNames(explained);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
    expect(indexNames(explained)).toEqual(['session_site_started']);
    const seen = examined(explained);
    expect(seen.docs).toBeLessThanOrEqual(stays);
    const ms = await timed('sessions', pipeline);
    report.push(`cohorts (12 weeks): docs ${seen.docs}, keys ${seen.keys}, ${ms} ms`);
  });

  it('activity walks session_site_started once, the month before included', async () => {
    // Ninety days of the calendar, today included, as the dashboard asks.
    const plan = activityPlan({ siteId: SITE, from: NOW - 89 * DAY, to: NOW }, TIMEZONE);
    const pipeline = [
      ...activityDayStages(SITE, plan.span, TIMEZONE),
      ...activityFoldStages(plan.offset, ACTIVITY_WINDOWS),
    ];
    const explained = await explain('sessions', pipeline);
    const stages = stageNames(explained);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
    expect(indexNames(explained)).toEqual(['session_site_started']);
    const seen = examined(explained);
    expect(seen.docs).toBeLessThanOrEqual(staysIn90);
    const rows = await db.collection('sessions').aggregate(pipeline, { allowDiskUse: true }).toArray();
    // A few hundred deltas, whatever the traffic: never a row per visitor.
    expect(rows.length).toBeLessThan(600);
    const ms = await timed('sessions', pipeline);
    report.push(`activity (90 days + 29): docs ${seen.docs}, keys ${seen.keys}, ${rows.length} rows back, ${ms} ms`);
  });

  it('power users walk session_site_started once and look up only the page', async () => {
    const plan = activityPlan({ siteId: SITE, from: NOW - 30 * DAY, to: NOW }, TIMEZONE);
    const pipeline = powerUsersPipeline(SITE, plan.range, TIMEZONE, 2, 20);
    const explained = await explain('sessions', pipeline);
    const stages = stageNames(explained);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
    expect(indexNames(explained)).toEqual(['session_site_started', 'visitor_site_id']);
    const seen = examined(explained);
    const ms = await timed('sessions', pipeline);
    report.push(`power users (30 days, top 20): docs ${seen.docs}, keys ${seen.keys}, ${ms} ms`);
    expect(powerMinDays(30)).toBe(10);
  });

  // Since AN-VIT01 the goal's rows are walked on event_site_type_ts, which
  // holds a type's rows together, so the walk reads the custom events of the
  // range and not every pageview beside them.
  it('attribution walks event_site_type_ts, then reads each converter by unique key', async () => {
    const span = { from: NOW - 90 * DAY, to: NOW };
    const goal = { kind: 'event' as const, match: 'signup' };
    const pipeline = attributionConvertersPipeline(SITE, span, goal);
    const explained = await explain('events', pipeline);
    const stages = stageNames(explained);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
    expect(indexNames(explained)).toEqual(['event_site_type_ts']);
    const seen = examined(explained);
    const converters = await db.collection('events').aggregate(pipeline).toArray();
    const reads = attributionLookups(
      SITE,
      converters.map((row) => String(row._id)),
      converters.map((row) => String(row.sessionId)),
    );
    for (const [collection, read, index] of [
      ['visitors', reads.visitors, 'visitor_site_id'],
      ['sessions', reads.stays, 'session_site_id'],
    ] as const) {
      const found = (await db
        .collection(collection)
        .find(read.filter, { projection: read.projection })
        .explain('executionStats')) as Document;
      expect(stageNames(found)).not.toContain('COLLSCAN');
      expect(indexNames(found)).toEqual([index]);
      // One key and one document per converter, never the collection.
      expect(examined(found).docs).toBeLessThanOrEqual(converters.length);
    }
    const started = performance.now();
    const result = await store.attribution({ siteId: SITE, ...span, goal, dim: 'channel' });
    const ms = Math.round(performance.now() - started);
    expect(result.visitors).toBe(converters.length);
    const walk = await timed('events', [pipeline[0]!, { $count: 'rows' }]);
    report.push(
      `attribution (90 days): docs ${seen.docs}, keys ${seen.keys}, ${converters.length} converters, ${ms} ms end to end (the goal-row walk alone ${walk} ms)`,
    );
  });
});
