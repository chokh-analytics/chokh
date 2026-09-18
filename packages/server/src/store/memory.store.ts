import {
  DEFAULT_BREAKDOWN_LIMIT,
  MAX_HOUR_RANGE_MS,
  ONLINE_WINDOW_MS,
  ROLLED_DIMENSIONS,
  ROLLUP_TOTAL_DIM,
  SESSION_DIMENSIONS,
  SESSION_PATH_BY_DIMENSION,
  StoreQueryError,
  addSession,
  addTotals,
  assertFilterable,
  botSelector,
  bucketsBetween,
  comparisonRange,
  createMemoryPresence,
  dayBounds,
  dayKey,
  dimensionValue,
  finishMetrics,
  foldVisitor,
  groupForFold,
  matchesFilter,
  matchesSessionFilter,
  presenceEntryOf,
  profileFrom,
  readPlan,
  rollupTotalSelector,
  sessionDimensionValue,
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
} from './AnalyticsStore.js';

export interface MemoryStore extends AnalyticsStore {
  addSite(site: Site): void;
  stored(): StoredEvent[];
  sessionsOf(siteId: string, visitorId: string): StoredSession[];
  clear(): void;
}

// The reference adapter: everything the contract asks for, held in arrays. It
// is what the collector's tests read through, what an install with no
// MONGODB_URI runs on, and the second implementation the conformance suite is
// proved against. Nothing here survives a restart.

export function createMemoryStore(sites: Site[] = [], options: StoreOptions = {}): MemoryStore {
  const bySiteId = new Map<string, Site>(sites.map((site) => [site.id, site]));
  const now = options.now ?? ((): number => Date.now());
  // A presence of our own unless a deployment handed one in. Closing is the
  // caller's business when they own it, the way the MongoDB adapter only
  // closes the client it opened.
  const ownPresence = createMemoryPresence();
  const presence: Presence = options.presence ?? ownPresence;
  let events: StoredEvent[] = [];
  let sessions: StoredSession[] = [];
  let visitors: StoredVisitor[] = [];
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

  // The stays that began in a span. A visit belongs to the day it started on,
  // so this is the one window a session is counted in.
  function rawSessions(query: Query, span: Range): StoredSession[] {
    if (!sessionsAnswerFilters(query.filters)) {
      // The filter names something a stay spans rather than has. Rather than
      // quietly dropping the filter, the visit numbers go unanswered.
      return [];
    }
    const wantsBots = botSelector(query.filters);
    return sessions.filter((session) => {
      if (
        session.siteId !== query.siteId ||
        session.startedAt < span.from ||
        session.startedAt >= span.to
      ) {
        return false;
      }
      if (session.bot !== wantsBots) {
        return false;
      }
      return (query.filters ?? []).every((filter) => matchesSessionFilter(session, filter));
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
    for (const session of rawSessions(query, span)) {
      addSession(totals, session);
    }
    return totals;
  }

  function rawBreakdown(
    query: Query,
    span: Range,
    dim: Dimension,
    timezone: string,
  ): Map<string, Totals> {
    const out = new Map<string, Totals>();
    const into = (key: string): Totals => {
      const totals = out.get(key) ?? zeroTotals();
      out.set(key, totals);
      return totals;
    };
    const perDay = new Map<string, Map<string, Set<string>>>();
    const countVisitor = (ts: number, key: string, visitorId: string): void => {
      const day = dayKey(ts, timezone);
      let byKey = perDay.get(day);
      if (byKey === undefined) {
        byKey = new Map();
        perDay.set(day, byKey);
      }
      let seen = byKey.get(key);
      if (seen === undefined) {
        seen = new Set();
        byKey.set(key, seen);
      }
      seen.add(visitorId);
    };

    // Visitors and pageviews come from events, except for the three dimensions
    // only a stay carries: nothing on an event says which page it came in on.
    const fromSessions = SESSION_DIMENSIONS.includes(dim);
    if (!fromSessions) {
      for (const event of rawRows(query, span)) {
        const value = dimensionValue(event, dim);
        if (value === undefined) continue;
        countVisitor(event.ts, value, event.visitorId);
        if (event.type === 'pageview') {
          into(value).pageviews += 1;
        }
      }
    }
    // Visits, bounces and duration always come from sessions, for every
    // dimension a session row carries.
    if (SESSION_PATH_BY_DIMENSION[dim] !== undefined) {
      for (const session of rawSessions(query, span)) {
        const value = sessionDimensionValue(session, dim);
        if (value === undefined) continue;
        const totals = into(value);
        if (fromSessions) {
          countVisitor(session.startedAt, value, session.visitorId);
          totals.pageviews += session.pageviews;
        }
        addSession(totals, session);
      }
    }

    for (const byKey of perDay.values()) {
      for (const [value, seen] of byKey) {
        into(value).visitors += seen.size;
      }
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
    const collect = (key: string, totals: Partial<Totals>): void => {
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

  function latestSession(siteId: string, visitorId: string): StoredSession | null {
    let found: StoredSession | null = null;
    for (const session of sessions) {
      if (session.siteId !== siteId || session.visitorId !== visitorId) continue;
      if (found === null || session.startedAt > found.startedAt) {
        found = session;
      }
    }
    return found;
  }

  function upsertSession(session: StoredSession): void {
    const at = sessions.findIndex((row) => row.siteId === session.siteId && row.id === session.id);
    if (at === -1) {
      sessions.push(session);
    } else {
      sessions[at] = session;
    }
  }

  function upsertVisitor(visitor: StoredVisitor): void {
    const at = visitors.findIndex((row) => row.siteId === visitor.siteId && row.id === visitor.id);
    if (at === -1) {
      visitors.push(visitor);
    } else {
      visitors[at] = visitor;
    }
  }

  return {
    addSite(site: Site): void {
      bySiteId.set(site.id, site);
    },

    site(siteId: string): Promise<Site | null> {
      return Promise.resolve(bySiteId.get(siteId) ?? null);
    },

    sites(): Promise<Site[]> {
      return Promise.resolve([...bySiteId.values()]);
    },

    async ingest(batch: StoredEvent[]): Promise<void> {
      const live: { siteId: string; entries: PresenceEntry[] }[] = [];
      for (const group of groupForFold(batch).values()) {
        const first = group[0];
        if (first === undefined) continue;
        const { siteId, visitorId } = first;
        const folded = foldVisitor({
          siteId,
          visitorId,
          events: group,
          open: latestSession(siteId, visitorId),
          visitor: visitors.find((row) => row.siteId === siteId && row.id === visitorId) ?? null,
        });

        // The merge: everything this visitor did before they were named takes
        // the name now, so a user lookup finds the anonymous history too.
        if (folded.merge !== undefined) {
          const userId = folded.merge;
          for (const event of events) {
            if (event.siteId === siteId && event.visitorId === visitorId) {
              event.userId = userId;
            }
          }
          for (const session of sessions) {
            if (session.siteId === siteId && session.visitorId === visitorId) {
              session.userId = userId;
            }
          }
        }

        for (const session of folded.sessions) {
          upsertSession(session);
        }
        upsertVisitor(folded.visitor);
        events = events.concat(folded.events);

        const entries = folded.sessions
          .map((session) => presenceEntryOf(session))
          .filter((entry): entry is PresenceEntry => entry !== null);
        if (entries.length > 0) {
          live.push({ siteId, entries });
        }
      }
      for (const { siteId, entries } of live) {
        await presence.touch(siteId, entries);
      }
    },

    stored(): StoredEvent[] {
      return events;
    },

    sessionsOf(siteId: string, visitorId: string): StoredSession[] {
      return sessions
        .filter((session) => session.siteId === siteId && session.visitorId === visitorId)
        .sort((left, right) => left.startedAt - right.startedAt);
    },

    clear(): void {
      events = [];
      sessions = [];
      visitors = [];
      rollups = [];
      ownPresence.clear();
    },

    async aggregate(query: Query): Promise<AggregateResult> {
      const site = siteOrThrow(query.siteId);
      assertFilterable(query.filters);
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
      assertFilterable(query.filters);
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
      assertFilterable(query.filters);
      if (query.dim === undefined) {
        throw new StoreQueryError('MISSING_DIMENSION', 'A breakdown needs a dim');
      }
      const rows = breakdownFor(query, query.dim, site);
      return { dim: query.dim, rows: rows.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT) };
    },

    async realtime(siteId: string): Promise<RealtimeSnapshot> {
      siteOrThrow(siteId);
      const at = now();
      return snapshotFrom(await presence.entries(siteId, at - ONLINE_WINDOW_MS), at);
    },

    visitor(siteId: string, visitorId: string): Promise<VisitorProfile | null> {
      const mine = events
        .filter((event) => event.siteId === siteId && event.visitorId === visitorId)
        .sort((left, right) => left.ts - right.ts);
      const rows = visitors.filter((row) => row.siteId === siteId && row.id === visitorId);
      if (mine.length === 0 && rows.length === 0) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ siteId, visitorId, ...profileFrom(mine, rows) });
    },

    user(siteId: string, userId: string): Promise<UserProfile | null> {
      const mine = events
        .filter((event) => event.siteId === siteId && event.userId === userId)
        .sort((left, right) => left.ts - right.ts);
      const rows = visitors.filter((row) => row.siteId === siteId && row.userId === userId);
      if (mine.length === 0 && rows.length === 0) {
        return Promise.resolve(null);
      }
      const visitorIds = [
        ...new Set([...rows.map((row) => row.id), ...mine.map((event) => event.visitorId)]),
      ].sort();
      return Promise.resolve({ siteId, visitorIds, ...profileFrom(mine, rows), userId });
    },

    async rollupDay(siteId: string, date: string): Promise<RollupSummary> {
      const site = siteOrThrow(siteId);
      const bounds = dayBounds(date, site.settings.timezone);
      const mine = events.filter(
        (event) => event.siteId === siteId && event.ts >= bounds.start && event.ts < bounds.end,
      );
      const stays = sessions.filter(
        (session) =>
          session.siteId === siteId &&
          session.startedAt >= bounds.start &&
          session.startedAt < bounds.end,
      );
      // A day with no rows of its own leaves whatever was rolled up before
      // alone. The retention purge takes the raw rows away long before the
      // rollups go, and a rerun after it must not wipe the history it was meant
      // to preserve.
      if (mine.length === 0 && stays.length === 0) {
        return { siteId, date, rows: 0, visitors: 0, pageviews: 0 };
      }

      const rows: RollupRecord[] = [];
      const push = (
        dim: RollupDim,
        key: string,
        pickedEvents: StoredEvent[],
        pickedSessions: StoredSession[],
        fromSessions = false,
      ): Totals => {
        const totals = zeroTotals();
        if (fromSessions) {
          totals.visitors = new Set(pickedSessions.map((session) => session.visitorId)).size;
          totals.pageviews = pickedSessions.reduce((sum, session) => sum + session.pageviews, 0);
        } else {
          totals.visitors = new Set(pickedEvents.map((event) => event.visitorId)).size;
          totals.pageviews = pickedEvents.filter((event) => event.type === 'pageview').length;
        }
        for (const session of pickedSessions) {
          addSession(totals, session);
        }
        rows.push({ siteId, date, dim, key, ...totals });
        return totals;
      };

      const humans = mine.filter((event) => !event.bot);
      const humanStays = stays.filter((session) => !session.bot);
      const totals = push(ROLLUP_TOTAL_DIM, '', humans, humanStays);
      for (const flag of [false, true]) {
        const picked = mine.filter((event) => event.bot === flag);
        const pickedStays = stays.filter((session) => session.bot === flag);
        if (picked.length > 0 || pickedStays.length > 0) {
          push('bot', String(flag), picked, pickedStays);
        }
      }

      for (const dim of ROLLED_DIMENSIONS) {
        const fromSessions = SESSION_DIMENSIONS.includes(dim);
        const eventsByValue = new Map<string, StoredEvent[]>();
        if (!fromSessions) {
          for (const event of humans) {
            const value = dimensionValue(event, dim);
            if (value === undefined) continue;
            const list = eventsByValue.get(value);
            if (list === undefined) eventsByValue.set(value, [event]);
            else list.push(event);
          }
        }
        const sessionsByValue = new Map<string, StoredSession[]>();
        if (SESSION_PATH_BY_DIMENSION[dim] !== undefined) {
          for (const session of humanStays) {
            const value = sessionDimensionValue(session, dim);
            if (value === undefined) continue;
            const list = sessionsByValue.get(value);
            if (list === undefined) sessionsByValue.set(value, [session]);
            else list.push(session);
          }
        }
        for (const value of new Set([...eventsByValue.keys(), ...sessionsByValue.keys()])) {
          push(
            dim,
            value,
            eventsByValue.get(value) ?? [],
            sessionsByValue.get(value) ?? [],
            fromSessions,
          );
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
      const keptVisitors = visitors.filter(
        (visitor) => visitor.siteId !== siteId || visitor.lastSeenAt >= before,
      );
      const summary: PurgeSummary = {
        events: events.length - keptEvents.length,
        sessions: sessions.length - keptSessions.length,
        visitors: visitors.length - keptVisitors.length,
      };
      events = keptEvents;
      sessions = keptSessions;
      visitors = keptVisitors;
      return Promise.resolve(summary);
    },

    close(): Promise<void> {
      return options.presence === undefined ? presence.close() : Promise.resolve();
    },
  };
}
