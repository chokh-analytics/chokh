import {
  DEFAULT_BREAKDOWN_LIMIT,
  MAX_HOUR_RANGE_MS,
  ONLINE_WINDOW_MS,
  PROFILE_EVENT_LIMIT,
  ROLLED_DIMENSIONS,
  ROLLUP_TOTAL_DIM,
  SESSION_DIMENSIONS,
  SESSION_PATH_BY_DIMENSION,
  StoreQueryError,
  addTotals,
  assertFilterable,
  botSelector,
  bucketsBetween,
  comparisonRange,
  createMemoryPresence,
  dayBounds,
  finishMetrics,
  foldVisitor,
  groupForFold,
  presenceEntryOf,
  profileFrom,
  readPlan,
  rollupTotalSelector,
  sessionsAnswerFilters,
  snapshotFrom,
  sortBreakdownRows,
  startOfDay,
  zeroTotals,
  type AggregateResult,
  type AnalyticsStore,
  type BreakdownResult,
  type BreakdownRow,
  type Dimension,
  type Interval,
  type Metrics,
  type Presence,
  type PresenceEntry,
  type PurgeSummary,
  type Query,
  type Range,
  type RealtimeSnapshot,
  type RollupDim,
  type RollupRecord,
  type RollupSummary,
  type Site,
  type StoreOptions,
  type StoredEvent,
  type StoredSession,
  type StoredVisitor,
  type TimeseriesPoint,
  type TimeseriesResult,
  type Totals,
  type UserProfile,
  type VisitorProfile,
} from '@chokh/store';
import { MongoClient, type AnyBulkWriteOperation, type Db, type Document } from 'mongodb';

import {
  rawBreakdownPipeline,
  rawTotalsPipeline,
  rollupBreakdownPipeline,
  rollupTotalsPipeline,
  sessionBreakdownPipeline,
  sessionSourcedBreakdownPipeline,
  sessionTotalsPipeline,
} from './pipelines.js';
import { EVENTS, ROLLUPS_DAILY, SESSIONS, SITES, VISITORS } from './schema.js';

// The MongoDB adapter. Everything below reads and writes through aggregation
// pipelines built in pipelines.ts; nothing here creates an index, because only
// `migrate --apply` does that.

const DAY_MS = 24 * 60 * 60 * 1000;
// A site row is read on every ingest to stamp the retention. It changes about
// never, so a short cache keeps the write path off the sites collection
// without letting a settings change wait longer than a coffee.
const SITE_CACHE_MS = 60_000;

export interface MongoStore extends AnalyticsStore {
  // Site creation belongs to AN-API01; this is how a migration, a test or a
  // seeding script puts one in until then.
  addSite(site: Site): Promise<void>;
  db: Db;
}

export interface MongoStoreOptions extends StoreOptions {
  uri?: string;
  client?: MongoClient;
  dbName?: string;
}

// The rows as they sit in MongoDB: the contract's shape plus the per document
// expiry the TTL indexes read.
type Expiring<T> = T & { expiresAt?: Date };
type EventDoc = Expiring<StoredEvent>;
type SessionDoc = Expiring<StoredSession>;
type VisitorDoc = Expiring<StoredVisitor>;

function totalsFrom(rows: Document[]): Totals {
  const totals = zeroTotals();
  for (const row of rows) {
    addTotals(totals, row as Partial<Totals>);
  }
  return totals;
}

export async function createMongoStore(options: MongoStoreOptions = {}): Promise<MongoStore> {
  const client = options.client ?? new MongoClient(requiredUri(options.uri));
  if (options.client === undefined) {
    await client.connect();
  }
  const db = client.db(options.dbName);
  const now = options.now ?? ((): number => Date.now());
  const presence: Presence = options.presence ?? createMemoryPresence();

  const events = db.collection<EventDoc>(EVENTS);
  const rollups = db.collection<RollupRecord>(ROLLUPS_DAILY);
  const sessions = db.collection<SessionDoc>(SESSIONS);
  const visitors = db.collection<VisitorDoc>(VISITORS);
  const sites = db.collection<Site>(SITES);

  const siteCache = new Map<string, { site: Site | null; until: number }>();

  async function readSite(siteId: string): Promise<Site | null> {
    const cached = siteCache.get(siteId);
    if (cached !== undefined && cached.until > now()) {
      return cached.site;
    }
    const doc = await sites.findOne({ id: siteId }, { projection: { _id: 0 } });
    const site: Site | null =
      doc === null
        ? null
        : { id: doc.id, name: doc.name, domains: doc.domains, settings: doc.settings };
    siteCache.set(siteId, { site, until: now() + SITE_CACHE_MS });
    return site;
  }

  async function siteOrThrow(siteId: string): Promise<Site> {
    const site = await readSite(siteId);
    if (site === null) {
      throw new StoreQueryError('UNKNOWN_SITE', `No site answers to ${siteId}`);
    }
    return site;
  }

  // Visits, bounces and time for a span, unless the query filtered on
  // something a stay spans rather than has, in which case they go unanswered.
  async function sessionTotals(query: Query, span: Range): Promise<Totals> {
    if (!sessionsAnswerFilters(query.filters)) {
      return zeroTotals();
    }
    const rows = await sessions
      .aggregate(
        sessionTotalsPipeline(query.siteId, span, botSelector(query.filters), query.filters),
      )
      .toArray();
    return totalsFrom(rows);
  }

  async function metricsFor(query: Query, range: Range, site: Site): Promise<Metrics> {
    const timezone = site.settings.timezone;
    const plan = readPlan({
      from: range.from,
      to: range.to,
      todayStart: startOfDay(now(), timezone),
      timezone,
      filters: query.filters,
    });
    const totals = zeroTotals();
    if (plan.days.length > 0) {
      const selector = rollupTotalSelector(query.filters);
      const rows = await rollups
        .aggregate(rollupTotalsPipeline(site.id, plan.days, selector.dim, selector.key))
        .toArray();
      addTotals(totals, totalsFrom(rows));
    }
    const wantsBots = botSelector(query.filters);
    for (const span of plan.raw) {
      const rows = await events
        .aggregate(rawTotalsPipeline(site.id, span, timezone, wantsBots, query.filters))
        .toArray();
      addTotals(totals, totalsFrom(rows));
      addTotals(totals, await sessionTotals(query, span));
    }
    return finishMetrics(totals);
  }

  async function breakdownFor(query: Query, dim: Dimension, site: Site): Promise<BreakdownRow[]> {
    const timezone = site.settings.timezone;
    const plan = readPlan({
      from: query.from,
      to: query.to,
      todayStart: startOfDay(now(), timezone),
      timezone,
      filters: query.filters,
      dim,
    });
    const byKey = new Map<string, Totals>();
    const collect = (key: string, row: Partial<Totals>): void => {
      const totals = byKey.get(key) ?? zeroTotals();
      addTotals(totals, row);
      byKey.set(key, totals);
    };

    if (plan.days.length > 0) {
      for (const row of await rollups
        .aggregate(rollupBreakdownPipeline(site.id, plan.days, dim))
        .toArray()) {
        collect(String(row._id), row as Partial<Totals>);
      }
    }
    const wantsBots = botSelector(query.filters);
    // Visitors and pageviews come from events, except for the three dimensions
    // only a stay carries. Visits, bounces and time always come from stays.
    const fromSessions = SESSION_DIMENSIONS.includes(dim);
    for (const span of plan.raw) {
      if (!fromSessions) {
        for (const row of await events
          .aggregate(rawBreakdownPipeline(site.id, span, timezone, dim, wantsBots, query.filters))
          .toArray()) {
          collect(String(row._id), row as Partial<Totals>);
        }
      }
      if (SESSION_PATH_BY_DIMENSION[dim] === undefined || !sessionsAnswerFilters(query.filters)) {
        continue;
      }
      const pipeline = fromSessions
        ? sessionSourcedBreakdownPipeline(
            site.id,
            span,
            timezone,
            dim,
            wantsBots,
            query.filters,
          )
        : sessionBreakdownPipeline(site.id, span, dim, wantsBots, query.filters);
      for (const row of await sessions.aggregate(pipeline).toArray()) {
        collect(String(row._id), row as Partial<Totals>);
      }
    }
    return sortBreakdownRows(
      [...byKey].map(([key, totals]) => ({ key, metrics: finishMetrics(totals) })),
    );
  }

  async function profile(
    filter: Document,
    visitorFilter: Document,
  ): Promise<{ body: ReturnType<typeof profileFrom>; visitorIds: string[] } | null> {
    const rows = await visitors
      .find<StoredVisitor>(visitorFilter, { projection: { _id: 0, expiresAt: 0 } })
      .toArray();
    // The custom event count is the one number the visitor row does not carry,
    // and it is taken without loading a history.
    const [summary] = await events
      .aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            firstSeenAt: { $min: '$ts' },
            lastSeenAt: { $max: '$ts' },
            pageviews: { $sum: { $cond: [{ $eq: ['$type', 'pageview'] }, 1, 0] } },
            events: { $sum: { $cond: [{ $eq: ['$type', 'event'] }, 1, 0] } },
            visitorIds: { $addToSet: '$visitorId' },
          },
        },
      ])
      .toArray();
    if (summary === undefined && rows.length === 0) {
      return null;
    }
    const recent = await events
      .find<StoredEvent>(filter, { projection: { _id: 0, expiresAt: 0 } })
      .sort({ ts: -1 })
      .limit(PROFILE_EVENT_LIMIT)
      .toArray();
    const ordered = recent.reverse();
    const fromEvents = (summary?.visitorIds as string[] | undefined) ?? [];
    const visitorIds = [...new Set([...rows.map((row) => row.id), ...fromEvents])].sort();
    const exact =
      summary === undefined
        ? undefined
        : {
            firstSeenAt: summary.firstSeenAt as number,
            lastSeenAt: summary.lastSeenAt as number,
            pageviews: summary.pageviews as number,
            events: summary.events as number,
          };
    return { body: profileFrom(ordered, rows, exact), visitorIds };
  }

  return {
    db,

    async addSite(site: Site): Promise<void> {
      await sites.replaceOne({ id: site.id }, site, { upsert: true });
      siteCache.delete(site.id);
    },

    site(siteId: string): Promise<Site | null> {
      return readSite(siteId);
    },

    async sites(): Promise<Site[]> {
      const docs = await sites.find({}, { projection: { _id: 0 } }).toArray();
      return docs.map((doc) => ({
        id: doc.id,
        name: doc.name,
        domains: doc.domains,
        settings: doc.settings,
      }));
    },

    async ingest(batch: StoredEvent[]): Promise<void> {
      if (batch.length === 0) {
        return;
      }
      const retention = new Map<string, number>();
      const days = async (siteId: string): Promise<number> => {
        let found = retention.get(siteId);
        if (found === undefined) {
          found = (await readSite(siteId))?.settings.retentionDays ?? 0;
          retention.set(siteId, found);
        }
        return found;
      };
      // A per-document expiry is how one collection holds many sites with
      // different retentions under one TTL index. A site with no retention set
      // keeps its rows until purge takes them.
      const expiring = <T extends object>(row: T, at: number, keep: number): Expiring<T> =>
        keep > 0 ? { ...row, expiresAt: new Date(at + keep * DAY_MS) } : { ...row };

      const docs: EventDoc[] = [];
      const sessionWrites: AnyBulkWriteOperation<SessionDoc>[] = [];
      const visitorWrites: AnyBulkWriteOperation<VisitorDoc>[] = [];
      const live: { siteId: string; entries: PresenceEntry[] }[] = [];

      for (const group of groupForFold(batch).values()) {
        const first = group[0];
        if (first === undefined) continue;
        const { siteId, visitorId } = first;
        const keep = await days(siteId);

        // Read, fold, write. Two batches of one visitor arriving at the same
        // moment can both read the same open stay and the later write wins, so
        // a count can be lost; a tab sends its batches one after another, and
        // the cure if that ever matters is a findOneAndUpdate, not a lock.
        const open = await sessions.findOne<StoredSession>(
          { siteId, visitorId },
          { projection: { _id: 0, expiresAt: 0 }, sort: { startedAt: -1 } },
        );
        const visitor = await visitors.findOne<StoredVisitor>(
          { siteId, id: visitorId },
          { projection: { _id: 0, expiresAt: 0 } },
        );
        const folded = foldVisitor({ siteId, visitorId, events: group, open, visitor });

        // The merge: everything this visitor did before they were named takes
        // the name now, so a user lookup finds the anonymous history too.
        if (folded.merge !== undefined) {
          const userId = folded.merge;
          await events.updateMany({ siteId, visitorId }, { $set: { userId } });
          await sessions.updateMany({ siteId, visitorId }, { $set: { userId } });
        }

        for (const event of folded.events) {
          docs.push(expiring(event, event.ts, keep));
        }
        for (const session of folded.sessions) {
          sessionWrites.push({
            replaceOne: {
              filter: { siteId, id: session.id },
              replacement: expiring(session, session.lastSeenAt, keep),
              upsert: true,
            },
          });
        }
        visitorWrites.push({
          replaceOne: {
            filter: { siteId, id: visitorId },
            replacement: expiring(folded.visitor, folded.visitor.lastSeenAt, keep),
            upsert: true,
          },
        });

        const entries = folded.sessions
          .map((session) => presenceEntryOf(session))
          .filter((entry): entry is PresenceEntry => entry !== null);
        if (entries.length > 0) {
          live.push({ siteId, entries });
        }
      }

      if (docs.length > 0) {
        await events.insertMany(docs, { ordered: false });
      }
      if (sessionWrites.length > 0) {
        await sessions.bulkWrite(sessionWrites, { ordered: false });
      }
      if (visitorWrites.length > 0) {
        await visitors.bulkWrite(visitorWrites, { ordered: false });
      }
      for (const { siteId, entries } of live) {
        await presence.touch(siteId, entries);
      }
    },

    async aggregate(query: Query): Promise<AggregateResult> {
      const site = await siteOrThrow(query.siteId);
      assertFilterable(query.filters);
      const range: Range = { from: query.from, to: query.to };
      const result: AggregateResult = {
        range,
        metrics: await metricsFor(query, range, site),
        previousRange: null,
        previous: null,
      };
      if (query.compare !== undefined) {
        const previousRange = comparisonRange(range, query.compare, site.settings.timezone);
        result.previousRange = previousRange;
        result.previous = await metricsFor(query, previousRange, site);
      }
      return result;
    },

    async timeseries(query: Query): Promise<TimeseriesResult> {
      const site = await siteOrThrow(query.siteId);
      assertFilterable(query.filters);
      const interval: Interval = query.interval ?? 'day';
      if (interval === 'hour' && query.to - query.from > MAX_HOUR_RANGE_MS) {
        throw new StoreQueryError(
          'RANGE_TOO_LONG',
          'An hourly series reads raw rows, so it is capped at 7 days. Ask for days instead.',
        );
      }
      const timezone = site.settings.timezone;
      const series = async (range: Range): Promise<TimeseriesPoint[]> => {
        const starts = bucketsBetween(range.from, range.to, interval, timezone);
        const points: TimeseriesPoint[] = [];
        for (const [index, start] of starts.entries()) {
          const end = starts[index + 1] ?? range.to;
          const clipped: Range = { from: Math.max(start, range.from), to: Math.min(end, range.to) };
          points.push({ start, end, metrics: await metricsFor(query, clipped, site) });
        }
        return points;
      };

      const range: Range = { from: query.from, to: query.to };
      const result: TimeseriesResult = { interval, points: await series(range), previous: null };
      if (query.compare !== undefined) {
        result.previous = await series(comparisonRange(range, query.compare, timezone));
      }
      return result;
    },

    async breakdown(query: Query): Promise<BreakdownResult> {
      const site = await siteOrThrow(query.siteId);
      assertFilterable(query.filters);
      if (query.dim === undefined) {
        throw new StoreQueryError('MISSING_DIMENSION', 'A breakdown needs a dim');
      }
      const rows = await breakdownFor(query, query.dim, site);
      return { dim: query.dim, rows: rows.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT) };
    },

    async realtime(siteId: string): Promise<RealtimeSnapshot> {
      await siteOrThrow(siteId);
      const at = now();
      return snapshotFrom(await presence.entries(siteId, at - ONLINE_WINDOW_MS), at);
    },

    async visitor(siteId: string, visitorId: string): Promise<VisitorProfile | null> {
      const found = await profile({ siteId, visitorId }, { siteId, id: visitorId });
      return found === null ? null : { siteId, visitorId, ...found.body };
    },

    async user(siteId: string, userId: string): Promise<UserProfile | null> {
      const found = await profile({ siteId, userId }, { siteId, userId });
      return found === null ? null : { siteId, visitorIds: found.visitorIds, ...found.body, userId };
    },

    async rollupDay(siteId: string, date: string): Promise<RollupSummary> {
      const site = await siteOrThrow(siteId);
      const timezone = site.settings.timezone;
      const bounds = dayBounds(date, timezone);
      const span: Range = { from: bounds.start, to: bounds.end };
      const rows: RollupRecord[] = [];

      const push = (dim: RollupDim, key: string, from: Document[], stays: Document[]): Totals => {
        const totals = totalsFrom(from);
        addTotals(totals, totalsFrom(stays));
        rows.push({ siteId, date, dim, key, ...totals });
        return totals;
      };

      const humans = await events
        .aggregate(rawTotalsPipeline(siteId, span, timezone, false, undefined))
        .toArray();
      const crawlers = await events
        .aggregate(rawTotalsPipeline(siteId, span, timezone, true, undefined))
        .toArray();
      const humanStays = await sessions
        .aggregate(sessionTotalsPipeline(siteId, span, false, undefined))
        .toArray();
      const crawlerStays = await sessions
        .aggregate(sessionTotalsPipeline(siteId, span, true, undefined))
        .toArray();
      if (
        humans.length === 0 &&
        crawlers.length === 0 &&
        humanStays.length === 0 &&
        crawlerStays.length === 0
      ) {
        // A day with no rows of its own leaves whatever was rolled up before
        // alone. The retention purge takes raw rows away long before the
        // rollups go, and a rerun after it must not wipe the history it
        // preserved.
        return { siteId, date, rows: 0, visitors: 0, pageviews: 0 };
      }

      const totals = push(ROLLUP_TOTAL_DIM, '', humans, humanStays);
      if (humans.length > 0 || humanStays.length > 0) push('bot', 'false', humans, humanStays);
      if (crawlers.length > 0 || crawlerStays.length > 0) {
        push('bot', 'true', crawlers, crawlerStays);
      }

      for (const dim of ROLLED_DIMENSIONS) {
        const fromSessions = SESSION_DIMENSIONS.includes(dim);
        const byKey = new Map<string, { events: Document[]; stays: Document[] }>();
        const slot = (key: string): { events: Document[]; stays: Document[] } => {
          const found = byKey.get(key) ?? { events: [], stays: [] };
          byKey.set(key, found);
          return found;
        };
        if (!fromSessions) {
          for (const row of await events
            .aggregate(rawBreakdownPipeline(siteId, span, timezone, dim, false, undefined))
            .toArray()) {
            slot(String(row._id)).events.push(row);
          }
        }
        if (SESSION_PATH_BY_DIMENSION[dim] !== undefined) {
          const pipeline = fromSessions
            ? sessionSourcedBreakdownPipeline(siteId, span, timezone, dim, false, undefined)
            : sessionBreakdownPipeline(siteId, span, dim, false, undefined);
          for (const row of await sessions.aggregate(pipeline).toArray()) {
            slot(String(row._id)).stays.push(row);
          }
        }
        for (const [key, picked] of byKey) {
          push(dim, key, picked.events, picked.stays);
        }
      }

      await rollups.deleteMany({ siteId, date });
      if (rows.length > 0) {
        await rollups.insertMany(rows, { ordered: false });
      }
      return {
        siteId,
        date,
        rows: rows.length,
        visitors: totals.visitors,
        pageviews: totals.pageviews,
      };
    },

    async purge(siteId: string, before: number): Promise<PurgeSummary> {
      const removedEvents = await events.deleteMany({ siteId, ts: { $lt: before } });
      const removedSessions = await sessions.deleteMany({ siteId, lastSeenAt: { $lt: before } });
      const removedVisitors = await visitors.deleteMany({ siteId, lastSeenAt: { $lt: before } });
      return {
        events: removedEvents.deletedCount,
        sessions: removedSessions.deletedCount,
        visitors: removedVisitors.deletedCount,
      };
    },

    async close(): Promise<void> {
      if (options.presence === undefined) {
        await presence.close();
      }
      if (options.client === undefined) {
        await client.close();
      }
    },
  };
}

function requiredUri(uri: string | undefined): string {
  if (uri === undefined || uri === '') {
    throw new Error('createMongoStore needs a uri or a client');
  }
  return uri;
}
