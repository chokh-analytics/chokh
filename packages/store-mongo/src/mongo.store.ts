import {
  DEFAULT_BREAKDOWN_LIMIT,
  MAX_HOUR_RANGE_MS,
  ONLINE_WINDOW_MS,
  PROFILE_EVENT_LIMIT,
  REALTIME_WINDOW_MS,
  ROLLED_DIMENSIONS,
  ROLLUP_TOTAL_DIM,
  SESSION_DIMENSIONS,
  StoreQueryError,
  addTotals,
  botSelector,
  bucketsBetween,
  comparisonRange,
  dayBounds,
  finishMetrics,
  profileFromEvents,
  readPlan,
  rollupTotalSelector,
  sortBreakdownRows,
  startOfDay,
  zeroTotals,
  type AggregateResult,
  type AnalyticsStore,
  type BreakdownResult,
  type BreakdownRow,
  type CountRow,
  type Dimension,
  type Interval,
  type Metrics,
  type PurgeSummary,
  type Query,
  type Range,
  type RealtimeSnapshot,
  type RealtimeVisitor,
  type RollupDim,
  type RollupRecord,
  type RollupSummary,
  type Site,
  type StoreOptions,
  type StoredEvent,
  type StoredSession,
  type TimeseriesPoint,
  type TimeseriesResult,
  type Totals,
  type UserProfile,
  type VisitorProfile,
} from '@chokh/store';
import { MongoClient, type Db, type Document } from 'mongodb';

import {
  rawBreakdownPipeline,
  rawTotalsPipeline,
  rollupBreakdownPipeline,
  rollupTotalsPipeline,
} from './pipelines.js';
import { EVENTS, ROLLUPS_DAILY, SESSIONS, SITES } from './schema.js';

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

// The event as it sits in MongoDB: the contract's shape plus the per document
// expiry the TTL index reads.
type EventDoc = StoredEvent & { expiresAt?: Date };

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

  const events = db.collection<EventDoc>(EVENTS);
  const rollups = db.collection<RollupRecord>(ROLLUPS_DAILY);
  const sessions = db.collection<StoredSession>(SESSIONS);
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
    }
    return finishMetrics(totals);
  }

  async function breakdownFor(query: Query, dim: Dimension, site: Site): Promise<BreakdownRow[]> {
    if (SESSION_DIMENSIONS.includes(dim)) {
      // Entry, exit and channel are facts about a session. AN-SES01 writes
      // them; until then there is nothing to group.
      return [];
    }
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
    for (const span of plan.raw) {
      for (const row of await events
        .aggregate(rawBreakdownPipeline(site.id, span, timezone, dim, wantsBots, query.filters))
        .toArray()) {
        collect(String(row._id), row as Partial<Totals>);
      }
    }
    return sortBreakdownRows(
      [...byKey].map(([key, totals]) => ({ key, metrics: finishMetrics(totals) })),
    );
  }

  async function profile(
    filter: Document,
  ): Promise<{ body: ReturnType<typeof profileFromEvents>; visitorIds: string[] } | null> {
    // Exact counts without loading a history, then the recent events the
    // timeline, device list and address list are drawn from. AN-SES01's
    // visitors row replaces the second half of this.
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
    if (summary === undefined) {
      return null;
    }
    const recent: StoredEvent[] = await events
      .find(filter, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(PROFILE_EVENT_LIMIT)
      .toArray();
    const ordered = recent.reverse();
    const visitorIds = (summary.visitorIds as string[]).slice().sort();
    const sessionCount = await sessions.countDocuments({
      siteId: filter.siteId as string,
      visitorId: { $in: visitorIds },
    });
    return {
      body: profileFromEvents(ordered, {
        firstSeenAt: summary.firstSeenAt as number,
        lastSeenAt: summary.lastSeenAt as number,
        pageviews: summary.pageviews as number,
        events: summary.events as number,
        sessions: sessionCount,
      }),
      visitorIds,
    };
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

    async ingest(batch: StoredEvent[]): Promise<void> {
      if (batch.length === 0) {
        return;
      }
      const retention = new Map<string, number>();
      const docs: EventDoc[] = [];
      for (const event of batch) {
        let days = retention.get(event.siteId);
        if (days === undefined) {
          days = (await readSite(event.siteId))?.settings.retentionDays ?? 0;
          retention.set(event.siteId, days);
        }
        // A per-document expiry is how one collection holds many sites with
        // different retentions under one TTL index. A site with no retention
        // set keeps its rows until purge takes them.
        docs.push(
          days > 0 ? { ...event, expiresAt: new Date(event.ts + days * DAY_MS) } : { ...event },
        );
      }
      await events.insertMany(docs, { ordered: false });
    },

    async aggregate(query: Query): Promise<AggregateResult> {
      const site = await siteOrThrow(query.siteId);
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
      if (query.dim === undefined) {
        throw new StoreQueryError('MISSING_DIMENSION', 'A breakdown needs a dim');
      }
      const rows = await breakdownFor(query, query.dim, site);
      return { dim: query.dim, rows: rows.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT) };
    },

    async realtime(siteId: string): Promise<RealtimeSnapshot> {
      await siteOrThrow(siteId);
      const at = now();
      const recent: StoredEvent[] = await events
        .find(
          { siteId, bot: false, ts: { $gt: at - REALTIME_WINDOW_MS, $lte: at } },
          { projection: { _id: 0 } },
        )
        .sort({ ts: 1 })
        .toArray();

      const byVisitor = new Map<string, StoredEvent[]>();
      for (const event of recent) {
        const list = byVisitor.get(event.visitorId);
        if (list === undefined) {
          byVisitor.set(event.visitorId, [event]);
        } else {
          list.push(event);
        }
      }

      const visitors: RealtimeVisitor[] = [];
      for (const [visitorId, list] of byVisitor) {
        const last = list[list.length - 1];
        if (last === undefined || last.ts <= at - ONLINE_WINDOW_MS) {
          continue;
        }
        const withPath = [...list].reverse().find((event) => event.path !== undefined);
        const visitor: RealtimeVisitor = {
          visitorId,
          since: list[0]?.ts ?? last.ts,
          lastSeenAt: last.ts,
        };
        if (last.userId !== undefined) visitor.userId = last.userId;
        if (withPath?.path !== undefined) visitor.path = withPath.path;
        if (last.geo?.country !== undefined) visitor.country = last.geo.country;
        if (last.geo?.city !== undefined) visitor.city = last.geo.city;
        if (last.ua?.browser !== undefined) visitor.browser = last.ua.browser;
        if (last.ua?.os !== undefined) visitor.os = last.ua.os;
        if (last.ua?.device !== undefined) visitor.device = last.ua.device;
        if (last.ip !== undefined) visitor.ip = last.ip;
        visitors.push(visitor);
      }
      visitors.sort((left, right) => right.lastSeenAt - left.lastSeenAt);

      const tally = (pick: (visitor: RealtimeVisitor) => string | undefined): CountRow[] => {
        const counts = new Map<string, number>();
        for (const visitor of visitors) {
          const key = pick(visitor);
          if (key === undefined) continue;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts]
          .map(([key, total]) => ({ key, visitors: total }))
          .sort((left, right) => right.visitors - left.visitors || left.key.localeCompare(right.key));
      };

      const signedIn = visitors.filter((visitor) => visitor.userId !== undefined).length;
      return {
        online: visitors.length,
        signedIn,
        anonymous: visitors.length - signedIn,
        byPage: tally((visitor) => visitor.path),
        byCountry: tally((visitor) => visitor.country),
        visitors,
      };
    },

    async visitor(siteId: string, visitorId: string): Promise<VisitorProfile | null> {
      const found = await profile({ siteId, visitorId });
      return found === null ? null : { siteId, visitorId, ...found.body };
    },

    async user(siteId: string, userId: string): Promise<UserProfile | null> {
      const found = await profile({ siteId, userId });
      return found === null ? null : { siteId, visitorIds: found.visitorIds, ...found.body, userId };
    },

    async rollupDay(siteId: string, date: string): Promise<RollupSummary> {
      const site = await siteOrThrow(siteId);
      const timezone = site.settings.timezone;
      const bounds = dayBounds(date, timezone);
      const span: Range = { from: bounds.start, to: bounds.end };
      const rows: RollupRecord[] = [];

      const push = (dim: RollupDim, key: string, from: Document[]): Totals => {
        const totals = totalsFrom(from);
        // visits, bounces and durationSum stay at zero: they are facts about a
        // session, and AN-SES01 writes sessions and decides how one attributes
        // to a page or a country.
        rows.push({ siteId, date, dim, key, ...totals });
        return totals;
      };

      const humans = await events
        .aggregate(rawTotalsPipeline(siteId, span, timezone, false, undefined))
        .toArray();
      const crawlers = await events
        .aggregate(rawTotalsPipeline(siteId, span, timezone, true, undefined))
        .toArray();
      if (humans.length === 0 && crawlers.length === 0) {
        // A day with no raw rows leaves whatever was rolled up before alone.
        // The retention purge takes raw rows away long before the rollups go,
        // and a rerun after it must not wipe the history it preserved.
        return { siteId, date, rows: 0, visitors: 0, pageviews: 0 };
      }

      const totals = push(ROLLUP_TOTAL_DIM, '', humans);
      if (humans.length > 0) push('bot', 'false', humans);
      if (crawlers.length > 0) push('bot', 'true', crawlers);

      for (const dim of ROLLED_DIMENSIONS) {
        const grouped = await events
          .aggregate(rawBreakdownPipeline(siteId, span, timezone, dim, false, undefined))
          .toArray();
        for (const row of grouped) {
          push(dim, String(row._id), [row]);
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
      return {
        events: removedEvents.deletedCount,
        sessions: removedSessions.deletedCount,
      };
    },

    async close(): Promise<void> {
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
