import {
  DEFAULT_BREAKDOWN_LIMIT,
  MAX_HOUR_RANGE_MS,
  ONLINE_WINDOW_MS,
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
  dayKey,
  dimensionValue,
  finishMetrics,
  matchesFilter,
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
  type ProfileBody,
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
} from './AnalyticsStore.js';

export interface MemoryStore extends AnalyticsStore {
  addSite(site: Site): void;
  stored(): StoredEvent[];
  clear(): void;
}

// The reference adapter: everything the contract asks for, held in arrays. It
// is what the collector's tests read through, what an install with no
// MONGODB_URI runs on, and the second implementation the conformance suite is
// proved against. Nothing here survives a restart.

export function createMemoryStore(sites: Site[] = [], options: StoreOptions = {}): MemoryStore {
  const bySiteId = new Map<string, Site>(sites.map((site) => [site.id, site]));
  const now = options.now ?? ((): number => Date.now());
  let events: StoredEvent[] = [];
  let sessions: StoredSession[] = [];
  let rollups: RollupRecord[] = [];

  function siteOrThrow(siteId: string): Site {
    const site = bySiteId.get(siteId);
    if (site === undefined) {
      throw new StoreQueryError('UNKNOWN_SITE', `No site answers to ${siteId}`);
    }
    return site;
  }

  // Raw rows of a span that pass the query's filters, bots included only when
  // the query asked for them.
  function rawRows(query: Query, span: Range): StoredEvent[] {
    const wantsBots = botSelector(query.filters);
    return events.filter((event) => {
      if (event.siteId !== query.siteId || event.ts < span.from || event.ts >= span.to) {
        return false;
      }
      if (event.bot !== wantsBots) {
        return false;
      }
      return (query.filters ?? []).every((filter) => matchesFilter(event, filter));
    });
  }

  // A day at a time, because a unique visitor is a per-day fact: two days of
  // the same person are two visitors, the way a daily rollup counts them.
  function rawTotals(query: Query, span: Range, timezone: string): Totals {
    const totals = zeroTotals();
    const perDay = new Map<string, Set<string>>();
    for (const event of rawRows(query, span)) {
      const key = dayKey(event.ts, timezone);
      let seen = perDay.get(key);
      if (seen === undefined) {
        seen = new Set();
        perDay.set(key, seen);
      }
      seen.add(event.visitorId);
      if (event.type === 'pageview') {
        totals.pageviews += 1;
      }
    }
    for (const seen of perDay.values()) {
      totals.visitors += seen.size;
    }
    return totals;
  }

  function rawBreakdown(
    query: Query,
    span: Range,
    dim: Dimension,
    timezone: string,
  ): Map<string, Totals> {
    const pageviews = new Map<string, number>();
    const perDay = new Map<string, Map<string, Set<string>>>();
    for (const event of rawRows(query, span)) {
      const value = dimensionValue(event, dim);
      if (value === undefined) {
        continue;
      }
      if (event.type === 'pageview') {
        pageviews.set(value, (pageviews.get(value) ?? 0) + 1);
      }
      const day = dayKey(event.ts, timezone);
      let byKey = perDay.get(day);
      if (byKey === undefined) {
        byKey = new Map();
        perDay.set(day, byKey);
      }
      let seen = byKey.get(value);
      if (seen === undefined) {
        seen = new Set();
        byKey.set(value, seen);
      }
      seen.add(event.visitorId);
    }
    const out = new Map<string, Totals>();
    for (const byKey of perDay.values()) {
      for (const [value, seen] of byKey) {
        const totals = out.get(value) ?? zeroTotals();
        totals.visitors += seen.size;
        out.set(value, totals);
      }
    }
    for (const [value, count] of pageviews) {
      const totals = out.get(value) ?? zeroTotals();
      totals.pageviews = count;
      out.set(value, totals);
    }
    return out;
  }

  function rollupRows(siteId: string, days: string[], dim: RollupDim, key?: string): RollupRecord[] {
    const wanted = new Set(days);
    return rollups.filter(
      (row) =>
        row.siteId === siteId &&
        wanted.has(row.date) &&
        row.dim === dim &&
        (key === undefined || row.key === key),
    );
  }

  function metricsFor(query: Query, range: Range, site: Site): Metrics {
    const timezone = site.settings.timezone;
    const plan = readPlan({
      from: range.from,
      to: range.to,
      todayStart: startOfDay(now(), timezone),
      timezone,
      filters: query.filters,
    });
    const totals = zeroTotals();
    const selector = rollupTotalSelector(query.filters);
    for (const row of rollupRows(site.id, plan.days, selector.dim, selector.key)) {
      addTotals(totals, row);
    }
    for (const span of plan.raw) {
      addTotals(totals, rawTotals(query, span, timezone));
    }
    return finishMetrics(totals);
  }

  function breakdownFor(query: Query, dim: Dimension, site: Site): BreakdownRow[] {
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
    const collect = (key: string, totals: Totals): void => {
      const existing = byKey.get(key) ?? zeroTotals();
      addTotals(existing, totals);
      byKey.set(key, existing);
    };
    for (const row of rollupRows(site.id, plan.days, dim)) {
      collect(row.key, row);
    }
    for (const span of plan.raw) {
      for (const [key, totals] of rawBreakdown(query, span, dim, timezone)) {
        collect(key, totals);
      }
    }
    return sortBreakdownRows(
      [...byKey].map(([key, totals]) => ({ key, metrics: finishMetrics(totals) })),
    );
  }

  function profileFrom(mine: StoredEvent[]): ProfileBody {
    const ordered = [...mine].sort((left, right) => left.ts - right.ts);
    const visitorIds = new Set(ordered.map((event) => event.visitorId));
    return profileFromEvents(ordered, {
      sessions: sessions.filter((session) => visitorIds.has(session.visitorId)).length,
    });
  }

  return {
    addSite(site: Site): void {
      bySiteId.set(site.id, site);
    },

    site(siteId: string): Promise<Site | null> {
      return Promise.resolve(bySiteId.get(siteId) ?? null);
    },

    ingest(batch: StoredEvent[]): Promise<void> {
      events = events.concat(batch);
      return Promise.resolve();
    },

    stored(): StoredEvent[] {
      return events;
    },

    clear(): void {
      events = [];
      sessions = [];
      rollups = [];
    },

    async aggregate(query: Query): Promise<AggregateResult> {
      const site = siteOrThrow(query.siteId);
      const range: Range = { from: query.from, to: query.to };
      const result: AggregateResult = {
        range,
        metrics: metricsFor(query, range, site),
        previousRange: null,
        previous: null,
      };
      if (query.compare !== undefined) {
        const previousRange = comparisonRange(range, query.compare, site.settings.timezone);
        result.previousRange = previousRange;
        result.previous = metricsFor(query, previousRange, site);
      }
      return result;
    },

    async timeseries(query: Query): Promise<TimeseriesResult> {
      const site = siteOrThrow(query.siteId);
      const interval: Interval = query.interval ?? 'day';
      if (interval === 'hour' && query.to - query.from > MAX_HOUR_RANGE_MS) {
        throw new StoreQueryError(
          'RANGE_TOO_LONG',
          'An hourly series reads raw rows, so it is capped at 7 days. Ask for days instead.',
        );
      }
      const timezone = site.settings.timezone;
      const series = (range: Range): TimeseriesPoint[] =>
        bucketsBetween(range.from, range.to, interval, timezone).map((start, index, all) => {
          const next = all[index + 1];
          const end = next ?? range.to;
          const clipped: Range = { from: Math.max(start, range.from), to: Math.min(end, range.to) };
          return { start, end, metrics: metricsFor(query, clipped, site) };
        });

      const range: Range = { from: query.from, to: query.to };
      const result: TimeseriesResult = { interval, points: series(range), previous: null };
      if (query.compare !== undefined) {
        result.previous = series(comparisonRange(range, query.compare, timezone));
      }
      return result;
    },

    async breakdown(query: Query): Promise<BreakdownResult> {
      const site = siteOrThrow(query.siteId);
      if (query.dim === undefined) {
        throw new StoreQueryError('MISSING_DIMENSION', 'A breakdown needs a dim');
      }
      const rows = breakdownFor(query, query.dim, site);
      return { dim: query.dim, rows: rows.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT) };
    },

    async realtime(siteId: string): Promise<RealtimeSnapshot> {
      siteOrThrow(siteId);
      const at = now();
      const recent = events.filter(
        (event) =>
          event.siteId === siteId && !event.bot && event.ts > at - REALTIME_WINDOW_MS && event.ts <= at,
      );
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
        const ordered = [...list].sort((left, right) => left.ts - right.ts);
        const last = ordered[ordered.length - 1];
        if (last === undefined || last.ts <= at - ONLINE_WINDOW_MS) {
          continue;
        }
        const withPath = [...ordered].reverse().find((event) => event.path !== undefined);
        const visitor: RealtimeVisitor = {
          visitorId,
          since: ordered[0]?.ts ?? last.ts,
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

      const count = (pick: (visitor: RealtimeVisitor) => string | undefined): CountRow[] => {
        const tally = new Map<string, number>();
        for (const visitor of visitors) {
          const key = pick(visitor);
          if (key === undefined) continue;
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
        return [...tally]
          .map(([key, total]) => ({ key, visitors: total }))
          .sort((left, right) => right.visitors - left.visitors || left.key.localeCompare(right.key));
      };

      const signedIn = visitors.filter((visitor) => visitor.userId !== undefined).length;
      return {
        online: visitors.length,
        signedIn,
        anonymous: visitors.length - signedIn,
        byPage: count((visitor) => visitor.path),
        byCountry: count((visitor) => visitor.country),
        visitors,
      };
    },

    visitor(siteId: string, visitorId: string): Promise<VisitorProfile | null> {
      const mine = events.filter(
        (event) => event.siteId === siteId && event.visitorId === visitorId,
      );
      if (mine.length === 0) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ siteId, visitorId, ...profileFrom(mine) });
    },

    user(siteId: string, userId: string): Promise<UserProfile | null> {
      const mine = events.filter((event) => event.siteId === siteId && event.userId === userId);
      if (mine.length === 0) {
        return Promise.resolve(null);
      }
      const visitorIds = [...new Set(mine.map((event) => event.visitorId))];
      return Promise.resolve({ siteId, visitorIds, ...profileFrom(mine), userId });
    },

    async rollupDay(siteId: string, date: string): Promise<RollupSummary> {
      const site = siteOrThrow(siteId);
      const bounds = dayBounds(date, site.settings.timezone);
      const mine = events.filter(
        (event) => event.siteId === siteId && event.ts >= bounds.start && event.ts < bounds.end,
      );
      // A day with no raw rows leaves whatever was rolled up before alone. The
      // retention purge takes the raw rows away long before the rollups go, and
      // a rerun after it must not wipe the history it was meant to preserve.
      if (mine.length === 0) {
        return { siteId, date, rows: 0, visitors: 0, pageviews: 0 };
      }

      const rows: RollupRecord[] = [];
      const push = (dim: RollupDim, key: string, picked: StoredEvent[]): Totals => {
        const totals = zeroTotals();
        totals.visitors = new Set(picked.map((event) => event.visitorId)).size;
        totals.pageviews = picked.filter((event) => event.type === 'pageview').length;
        // visits, bounces and durationSum stay at zero: they are facts about a
        // session, and AN-SES01 writes sessions and decides how one attributes
        // to a page or a country.
        rows.push({ siteId, date, dim, key, ...totals });
        return totals;
      };

      const humans = mine.filter((event) => !event.bot);
      const totals = push(ROLLUP_TOTAL_DIM, '', humans);
      for (const flag of [false, true]) {
        const picked = mine.filter((event) => event.bot === flag);
        if (picked.length > 0) {
          push('bot', String(flag), picked);
        }
      }
      for (const dim of ROLLED_DIMENSIONS) {
        const byValue = new Map<string, StoredEvent[]>();
        for (const event of humans) {
          const value = dimensionValue(event, dim);
          if (value === undefined) continue;
          const list = byValue.get(value);
          if (list === undefined) byValue.set(value, [event]);
          else list.push(event);
        }
        for (const [value, picked] of byValue) {
          push(dim, value, picked);
        }
      }

      rollups = rollups
        .filter((row) => !(row.siteId === siteId && row.date === date))
        .concat(rows);
      return {
        siteId,
        date,
        rows: rows.length,
        visitors: totals.visitors,
        pageviews: totals.pageviews,
      };
    },

    purge(siteId: string, before: number): Promise<PurgeSummary> {
      const keptEvents = events.filter((event) => event.siteId !== siteId || event.ts >= before);
      const keptSessions = sessions.filter(
        (session) => session.siteId !== siteId || session.lastSeenAt >= before,
      );
      const summary: PurgeSummary = {
        events: events.length - keptEvents.length,
        sessions: sessions.length - keptSessions.length,
      };
      events = keptEvents;
      sessions = keptSessions;
      return Promise.resolve(summary);
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
