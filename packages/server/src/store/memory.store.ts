import {
  DEFAULT_BREAKDOWN_LIMIT,
  MAX_FUNNELS_PER_SITE,
  JOURNEY_ROWS_PER_VISIT,
  MAX_FUNNEL_ROWS_PER_VISITOR,
  MAX_GOALS_PER_SITE,
  MAX_PROPERTY_KEYS,
  REALTIME_WINDOW_MS,
  ROLLED_DIMENSIONS,
  ROLLUP_TOTAL_DIM,
  SESSION_DIMENSIONS,
  SESSION_PATH_BY_DIMENSION,
  StoreQueryError,
  addLeave,
  addSession,
  addTotals,
  assertEngageable,
  assertFunnelSteps,
  assertNoGoal,
  compareFunnelRows,
  finishFunnel,
  finishJourneys,
  funnelDepth,
  funnelHits,
  funnelWindowMs,
  journeyBranches,
  journeyPath,
  journeyStepCounts,
  topJourneyPages,
  splitVisitFilters,
  conversionMatcher,
  assertIntervalRange,
  botSelector,
  bucketsBetween,
  comparisonRange,
  createMemoryPresence,
  dayBounds,
  dayKey,
  dimensionValue,
  finishConversion,
  finishEngagement,
  finishEventRow,
  finishMetrics,
  foldVisitor,
  groupForFold,
  matchesFilter,
  matchesSessionFilter,
  presenceEntryOf,
  profileFrom,
  readPlan,
  rollupTotalSelector,
  routeMatchers,
  sameRouteRules,
  withRoute,
  sessionDimensionValue,
  sessionsAnswerFilters,
  snapshotFrom,
  sortBreakdownRows,
  sortEngagementRows,
  sortEventRows,
  sortPropertyCounts,
  startOfDay,
  zeroEngagement,
  zeroTotals,
  type AggregateResult,
  type AnalyticsStore,
  type BreakdownResult,
  type BreakdownRow,
  type Conversion,
  type Dimension,
  type EngagementResult,
  type EngagementTally,
  type EventsResult,
  type Funnel,
  type FunnelRead,
  type FunnelResult,
  type FunnelRow,
  type JourneyQuery,
  type JourneyResult,
  type Goal,
  type GoalRead,
  type GoalStatsResult,
  type PropertyCount,
  type PropertyQuery,
  type PropertyResult,
  type Interval,
  type Metrics,
  type Presence,
  type PresenceEntry,
  type PurgeSummary,
  type Query,
  type Range,
  type RealtimeSnapshot,
  type RollupDim,
  type RegroupSummary,
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
  type AccountStore,
  type ApiKeyRecord,
  type AuditRecord,
  type SitePatch,
  type StoredApiKey,
  type StoredTeam,
  type StoredUser,
  type TeamMember,
  type UserPatch,
} from './AnalyticsStore.js';

export interface MemoryStore extends AnalyticsStore, AccountStore {
  stored(): StoredEvent[];
  sessionsOf(siteId: string, visitorId: string): StoredSession[];
  clear(): void;
}

// Why a site cannot have an empty domain list, said once because both writes
// refuse it: the unique multikey index on sites.domains stores one null key for
// an empty array, so the second domainless site collides with the first, and a
// site with no domain could not pass the collector's origin check anyway.
const NO_DOMAIN =
  'A site needs at least one domain: the unique index on sites.domains cannot hold two empty lists';

// A funnel holds an array of steps, so a copy that stopped at the top level
// would hand a caller the stored steps to change.
function copyFunnel(funnel: Funnel): Funnel {
  return { ...funnel, steps: funnel.steps.map((step) => ({ ...step })) };
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
  // The control plane, held the same way. createMemoryStore's sites argument is
  // still how a collector test seeds a site without going through createSite.
  let users: StoredUser[] = [];
  let teams: StoredTeam[] = [];
  let apiKeys: StoredApiKey[] = [];
  let auditLog: AuditRecord[] = [];
  let goals: Goal[] = [];
  let funnels: Funnel[] = [];

  function siteOrThrow(siteId: string): Site {
    const site = bySiteId.get(siteId);
    if (site === undefined) {
      throw new StoreQueryError('UNKNOWN_SITE', `No site answers to ${siteId}`);
    }
    return site;
  }

  // The route rollup of one day, rebuilt from its raw rows: what rollupDay
  // writes for that one dimension, and nothing else touched.
  function rerollRoute(siteId: string, date: string, timezone: string): void {
    const bounds = dayBounds(date, timezone);
    const byValue = new Map<string, StoredEvent[]>();
    for (const event of events) {
      if (
        event.siteId !== siteId ||
        event.bot ||
        event.ts < bounds.start ||
        event.ts >= bounds.end
      ) {
        continue;
      }
      const value = dimensionValue(event, 'route');
      if (value === undefined) continue;
      const list = byValue.get(value);
      if (list === undefined) byValue.set(value, [event]);
      else list.push(event);
    }
    const rows: RollupRecord[] = [...byValue].map(([key, picked]) => ({
      siteId,
      date,
      dim: 'route',
      key,
      ...zeroTotals(),
      visitors: new Set(picked.map((event) => event.visitorId)).size,
      pageviews: picked.filter((event) => event.type === 'pageview').length,
    }));
    rollups = rollups
      .filter((row) => !(row.siteId === siteId && row.date === date && row.dim === 'route'))
      .concat(rows);
  }

  // Raw rows of a span that pass the query's filters, bots included only when
  // the query asked for them.
  //
  // A filter only a stay carries is answered by the row's stay: the ids of
  // every stay of the site that matches all of them, looked up per row. There
  // is no window on the stay, on purpose: a row at ten past midnight belongs
  // to the stay that began before it, whichever day that was. A row written
  // before stays were stamped has no stay and is out, the rule the funnel
  // read already applies.
  function rawRows(query: Query, span: Range): StoredEvent[] {
    const wantsBots = botSelector(query.filters);
    const split = splitVisitFilters(query.filters);
    const stays =
      split.stay.length === 0
        ? null
        : new Set(
            sessions
              .filter(
                (session) =>
                  session.siteId === query.siteId &&
                  split.stay.every((filter) => matchesSessionFilter(session, filter)),
              )
              .map((session) => session.id),
          );
    return events.filter((event) => {
      if (event.siteId !== query.siteId || event.ts < span.from || event.ts >= span.to) {
        return false;
      }
      if (event.bot !== wantsBots) {
        return false;
      }
      if (stays !== null && (event.sessionId === undefined || !stays.has(event.sessionId))) {
        return false;
      }
      return split.event.every((filter) => matchesFilter(event, filter));
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

  // Per day, per value, the visitors a breakdown counted: the membership a
  // conversion is counted against.
  type Members = Map<string, Map<string, Set<string>>>;

  function rawBreakdown(
    query: Query,
    span: Range,
    dim: Dimension,
    timezone: string,
  ): { totals: Map<string, Totals>; members: Members } {
    const out = new Map<string, Totals>();
    const into = (key: string): Totals => {
      const totals = out.get(key) ?? zeroTotals();
      out.set(key, totals);
      return totals;
    };
    const perDay: Members = new Map();
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
    return { totals: out, members: perDay };
  }

  // Who reached the goal, per day, and how many times. Only the site, the span,
  // the bot side and the goal decide it: the query's other filters narrow the
  // people a conversion is counted against, never the goal.
  function rawConverters(
    query: Query,
    goal: GoalRead,
    span: Range,
    timezone: string,
  ): Map<string, Map<string, number>> {
    const wantsBots = botSelector(query.filters);
    const reached = conversionMatcher(goal);
    const out = new Map<string, Map<string, number>>();
    for (const event of events) {
      if (event.siteId !== query.siteId || event.ts < span.from || event.ts >= span.to) continue;
      if (event.bot !== wantsBots || !reached(event)) continue;
      const day = dayKey(event.ts, timezone);
      const byVisitor = out.get(day) ?? new Map<string, number>();
      out.set(day, byVisitor);
      byVisitor.set(event.visitorId, (byVisitor.get(event.visitorId) ?? 0) + 1);
    }
    return out;
  }

  // The overlap, day by day: the people counted who also converted that day.
  function overlap(
    counted: Map<string, Set<string>>,
    converters: Map<string, Map<string, number>>,
  ): { visitors: number; completions: number } {
    let visitors = 0;
    let completions = 0;
    for (const [day, seen] of counted) {
      const reached = converters.get(day);
      if (reached === undefined) continue;
      for (const visitorId of seen) {
        const times = reached.get(visitorId);
        if (times === undefined) continue;
        visitors += 1;
        completions += times;
      }
    }
    return { visitors, completions };
  }

  // The people a set of rows counts, per day.
  function visitorsByDay(rows: StoredEvent[], timezone: string): Map<string, Set<string>> {
    const counted = new Map<string, Set<string>>();
    for (const event of rows) {
      const day = dayKey(event.ts, timezone);
      const seen = counted.get(day) ?? new Set<string>();
      counted.set(day, seen);
      seen.add(event.visitorId);
    }
    return counted;
  }

  function visitorDays(counted: Map<string, Set<string>>): number {
    let total = 0;
    for (const seen of counted.values()) total += seen.size;
    return total;
  }

  // A goal read is raw for the whole range, so this is one span.
  function conversionFor(
    query: Query,
    goal: GoalRead,
    range: Range,
    site: Site,
    base: number,
  ): Conversion {
    const timezone = site.settings.timezone;
    const counted = visitorsByDay(rawRows(query, range), timezone);
    const converters = rawConverters(query, goal, range, timezone);
    return finishConversion(overlap(counted, converters), base, goal);
  }

  // Visitors, each day's added up, and how many rows, per key.
  function tallyBy(
    rows: StoredEvent[],
    keyOf: (event: StoredEvent) => string,
    timezone: string,
  ): Map<string, { visitors: number; events: number }> {
    const out = new Map<string, { visitors: number; events: number }>();
    const seen = new Map<string, Set<string>>();
    for (const event of rows) {
      const key = keyOf(event);
      const tally = out.get(key) ?? { visitors: 0, events: 0 };
      out.set(key, tally);
      tally.events += 1;
      const mark = `${dayKey(event.ts, timezone)}\n${key}`;
      const visitorsThatDay = seen.get(mark) ?? new Set<string>();
      seen.set(mark, visitorsThatDay);
      if (!visitorsThatDay.has(event.visitorId)) {
        visitorsThatDay.add(event.visitorId);
        tally.visitors += 1;
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

  // interval is the bucket these totals are going to be folded into. It is
  // passed to the plan rather than kept here, because a sub-day bucket cannot
  // be answered from a rollup and that rule belongs in the contract where both
  // adapters read it.
  function metricsFor(
    query: Query,
    range: Range,
    site: Site,
    interval?: Interval,
  ): Metrics {
    const timezone = site.settings.timezone;
    const plan = readPlan({
      from: range.from,
      to: range.to,
      todayStart: startOfDay(now(), timezone),
      timezone,
      filters: query.filters,
      ...(interval === undefined ? {} : { interval }),
      ...(query.goal === undefined ? {} : { goal: query.goal }),
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
      ...(query.goal === undefined ? {} : { goal: query.goal }),
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
    // With a goal the plan is one raw span, so these are the members of every
    // row there is.
    const members: Members = new Map();
    for (const span of plan.raw) {
      const read = rawBreakdown(query, span, dim, timezone);
      for (const [key, totals] of read.totals) {
        collect(key, totals);
      }
      for (const [day, byValue] of read.members) {
        members.set(day, byValue);
      }
    }
    const goal = query.goal;
    const converters =
      goal === undefined
        ? null
        : rawConverters(query, goal, { from: query.from, to: query.to }, timezone);
    return sortBreakdownRows(
      [...byKey].map(([key, totals]): BreakdownRow => {
        const metrics = finishMetrics(totals);
        if (goal === undefined || converters === null) {
          return { key, metrics };
        }
        const counted = new Map<string, Set<string>>();
        for (const [day, byValue] of members) {
          const seen = byValue.get(key);
          if (seen !== undefined) counted.set(day, seen);
        }
        return {
          key,
          metrics,
          conversion: finishConversion(overlap(counted, converters), metrics.visitors, goal),
        };
      }),
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
    createSite(site: Site): Promise<void> {
      if (site.domains.length === 0) {
        throw new StoreQueryError('DOMAIN_REQUIRED', NO_DOMAIN);
      }
      if (bySiteId.has(site.id)) {
        throw new StoreQueryError('SITE_EXISTS', `A site already answers to ${site.id}`);
      }
      const taken = site.domains.find((domain) =>
        [...bySiteId.values()].some((other) => other.domains.includes(domain)),
      );
      if (taken !== undefined) {
        throw new StoreQueryError('DOMAIN_TAKEN', `${taken} already belongs to another site`);
      }
      bySiteId.set(site.id, site);
      return Promise.resolve();
    },

    updateSite(siteId: string, patch: SitePatch): Promise<Site> {
      const current = siteOrThrow(siteId);
      const domains = patch.domains ?? current.domains;
      if (domains.length === 0) {
        throw new StoreQueryError('DOMAIN_REQUIRED', NO_DOMAIN);
      }
      const taken = domains.find((domain) =>
        [...bySiteId.values()].some(
          (other) => other.id !== siteId && other.domains.includes(domain),
        ),
      );
      if (taken !== undefined) {
        throw new StoreQueryError('DOMAIN_TAKEN', `${taken} already belongs to another site`);
      }
      const updated: Site = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.teamId === undefined ? {} : { teamId: patch.teamId }),
        domains,
        // Field by field, so a patch naming one setting does not reset the rest.
        settings: { ...current.settings, ...patch.settings },
      };
      // A change to the route rules is a change to what every stored row and
      // every route rollup says, so the site is marked and the jobs regroup it.
      if (
        patch.settings?.routeGroups !== undefined &&
        !sameRouteRules(current.settings.routeGroups, patch.settings.routeGroups)
      ) {
        updated.routesChangedAt = now();
      }
      bySiteId.set(siteId, updated);
      return Promise.resolve(updated);
    },

    createUser(user: StoredUser): Promise<void> {
      const email = user.email.toLowerCase();
      if (users.some((row) => row.email === email)) {
        throw new StoreQueryError('EMAIL_EXISTS', 'An account already uses that address');
      }
      users.push({ ...user, email });
      return Promise.resolve();
    },

    updateUser(userId: string, patch: UserPatch): Promise<void> {
      const at = users.findIndex((row) => row.id === userId);
      const current = users[at];
      if (current === undefined) {
        throw new StoreQueryError('UNKNOWN_USER', `No account answers to ${userId}`);
      }
      users[at] = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.passwordHash === undefined ? {} : { passwordHash: patch.passwordHash }),
        ...(patch.lastLoginAt === undefined ? {} : { lastLoginAt: patch.lastLoginAt }),
      };
      return Promise.resolve();
    },

    userById(userId: string): Promise<StoredUser | null> {
      return Promise.resolve(users.find((row) => row.id === userId) ?? null);
    },

    userByEmail(email: string): Promise<StoredUser | null> {
      const wanted = email.toLowerCase();
      return Promise.resolve(users.find((row) => row.email === wanted) ?? null);
    },

    userCount(): Promise<number> {
      return Promise.resolve(users.length);
    },

    createTeam(team: StoredTeam): Promise<void> {
      if (teams.some((row) => row.id === team.id)) {
        throw new StoreQueryError('TEAM_EXISTS', `A team already answers to ${team.id}`);
      }
      teams.push({ ...team, members: team.members.map((member) => ({ ...member })) });
      return Promise.resolve();
    },

    team(teamId: string): Promise<StoredTeam | null> {
      return Promise.resolve(teams.find((row) => row.id === teamId) ?? null);
    },

    teamsForUser(userId: string): Promise<StoredTeam[]> {
      return Promise.resolve(
        teams.filter((row) => row.members.some((member) => member.userId === userId)),
      );
    },

    setTeamMember(teamId: string, member: TeamMember): Promise<StoredTeam> {
      const team = teams.find((row) => row.id === teamId);
      if (team === undefined) {
        throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
      }
      const at = team.members.findIndex((row) => row.userId === member.userId);
      if (at === -1) {
        team.members.push({ ...member });
      } else {
        team.members[at] = { ...member };
      }
      return Promise.resolve(team);
    },

    createApiKey(key: StoredApiKey): Promise<void> {
      if (apiKeys.some((row) => row.keyHash === key.keyHash || row.id === key.id)) {
        throw new StoreQueryError('KEY_EXISTS', 'That key already exists');
      }
      apiKeys.push({ ...key });
      return Promise.resolve();
    },

    apiKeyByHash(keyHash: string): Promise<StoredApiKey | null> {
      return Promise.resolve(apiKeys.find((row) => row.keyHash === keyHash) ?? null);
    },

    apiKeys(siteId: string): Promise<ApiKeyRecord[]> {
      return Promise.resolve(
        apiKeys
          .filter((row) => row.siteId === siteId)
          // A hash is still a secret, so a list of keys is not a list of them.
          .map(({ keyHash: _keyHash, ...rest }) => rest),
      );
    },

    deleteApiKey(siteId: string, keyId: string): Promise<boolean> {
      const kept = apiKeys.filter((row) => !(row.siteId === siteId && row.id === keyId));
      const deleted = kept.length !== apiKeys.length;
      apiKeys = kept;
      return Promise.resolve(deleted);
    },

    goals(siteId: string): Promise<Goal[]> {
      return Promise.resolve(
        goals
          .filter((row) => row.siteId === siteId)
          .sort((left, right) => left.createdAt - right.createdAt)
          .map((row) => ({ ...row })),
      );
    },

    goal(siteId: string, goalId: string): Promise<Goal | null> {
      const found = goals.find((row) => row.siteId === siteId && row.id === goalId);
      return Promise.resolve(found === undefined ? null : { ...found });
    },

    async createGoal(goal: Goal): Promise<void> {
      siteOrThrow(goal.siteId);
      if (goals.some((row) => row.siteId === goal.siteId && row.id === goal.id)) {
        throw new StoreQueryError('GOAL_EXISTS', 'A goal already asks that question');
      }
      if (goals.filter((row) => row.siteId === goal.siteId).length >= MAX_GOALS_PER_SITE) {
        throw new StoreQueryError('GOAL_LIMIT', `A site can have at most ${MAX_GOALS_PER_SITE} goals`);
      }
      goals.push({ ...goal });
    },

    deleteGoal(siteId: string, goalId: string): Promise<boolean> {
      const kept = goals.filter((row) => !(row.siteId === siteId && row.id === goalId));
      const deleted = kept.length !== goals.length;
      goals = kept;
      return Promise.resolve(deleted);
    },

    funnels(siteId: string): Promise<Funnel[]> {
      return Promise.resolve(
        funnels
          .filter((row) => row.siteId === siteId)
          .sort((left, right) => left.createdAt - right.createdAt)
          .map(copyFunnel),
      );
    },

    funnel(siteId: string, funnelId: string): Promise<Funnel | null> {
      const found = funnels.find((row) => row.siteId === siteId && row.id === funnelId);
      return Promise.resolve(found === undefined ? null : copyFunnel(found));
    },

    async createFunnel(funnel: Funnel): Promise<void> {
      siteOrThrow(funnel.siteId);
      if (funnels.some((row) => row.siteId === funnel.siteId && row.id === funnel.id)) {
        throw new StoreQueryError('FUNNEL_EXISTS', 'A funnel already asks that question');
      }
      if (funnels.filter((row) => row.siteId === funnel.siteId).length >= MAX_FUNNELS_PER_SITE) {
        throw new StoreQueryError(
          'FUNNEL_LIMIT',
          `A site can have at most ${MAX_FUNNELS_PER_SITE} funnels`,
        );
      }
      funnels.push(copyFunnel(funnel));
    },

    deleteFunnel(siteId: string, funnelId: string): Promise<boolean> {
      const kept = funnels.filter((row) => !(row.siteId === siteId && row.id === funnelId));
      const deleted = kept.length !== funnels.length;
      funnels = kept;
      return Promise.resolve(deleted);
    },

    audit(row: AuditRecord): Promise<void> {
      auditLog.push({ ...row });
      return Promise.resolve();
    },

    auditTrail(siteId: string, from: number, to: number): Promise<AuditRecord[]> {
      return Promise.resolve(
        auditLog
          .filter((row) => row.siteId === siteId && row.ts >= from && row.ts < to)
          .sort((left, right) => left.ts - right.ts)
          .map((row) => ({ ...row })),
      );
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
        // The route each row is reported under, from the site's rules now.
        const matchers = routeMatchers(bySiteId.get(siteId)?.settings.routeGroups ?? []);
        const folded = foldVisitor({
          siteId,
          visitorId,
          events: group.map((event) => withRoute(event, matchers)),
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

        // Only the stays a browser was seen in. An event an application sent
        // server side moves the stay and puts nobody online.
        const entries = folded.live
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
      users = [];
      teams = [];
      apiKeys = [];
      auditLog = [];
      goals = [];
      funnels = [];
      bySiteId.clear();
      ownPresence.clear();
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
      if (query.goal !== undefined) {
        result.conversion = conversionFor(query, query.goal, range, site, result.metrics.visitors);
        result.previousConversion = null;
      }
      if (query.compare !== undefined) {
        // The same window the chart's dashed line uses, so the tile's
        // percentage and the line under it are answering one question. The
        // dashboard sends the interval on every read for exactly this reason.
        const previousRange = comparisonRange(
          range,
          query.compare,
          site.settings.timezone,
          query.interval,
        );
        result.previousRange = previousRange;
        result.previous = metricsFor(query, previousRange, site);
        if (query.goal !== undefined) {
          result.previousConversion = conversionFor(
            query,
            query.goal,
            previousRange,
            site,
            result.previous.visitors,
          );
        }
      }
      return result;
    },

    async timeseries(query: Query): Promise<TimeseriesResult> {
      const site = siteOrThrow(query.siteId);
      assertNoGoal(query, 'timeseries');
      const interval: Interval = query.interval ?? 'day';
      assertIntervalRange(interval, query.from, query.to);
      const timezone = site.settings.timezone;
      const series = (range: Range): TimeseriesPoint[] =>
        bucketsBetween(range.from, range.to, interval, timezone).map((start, index, all) => {
          const next = all[index + 1];
          const end = next ?? range.to;
          const clipped: Range = { from: Math.max(start, range.from), to: Math.min(end, range.to) };
          return { start, end, metrics: metricsFor(query, clipped, site, interval) };
        });

      const range: Range = { from: query.from, to: query.to };
      const result: TimeseriesResult = { interval, points: series(range), previous: null };
      if (query.compare !== undefined) {
        result.previous = series(comparisonRange(range, query.compare, timezone, interval));
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

    async engagement(query: Query): Promise<EngagementResult> {
      siteOrThrow(query.siteId);
      assertNoGoal(query, 'engagement');
      const dim = assertEngageable(query.dim);
      const tallies = new Map<string, EngagementTally>();
      // One span, the whole range: a leave lives in events and nowhere else,
      // so there is no rollup half of this read to plan around.
      for (const event of rawRows(query, { from: query.from, to: query.to })) {
        if (event.type !== 'leave') continue;
        const key = dimensionValue(event, dim);
        if (key === undefined) continue;
        const tally = tallies.get(key) ?? zeroEngagement();
        addLeave(tally, event);
        tallies.set(key, tally);
      }
      const rows = sortEngagementRows(
        [...tallies].map(([key, tally]) => finishEngagement(key, tally)),
      );
      return { dim, rows: rows.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT), rawOnly: true };
    },

    async events(query: Query): Promise<EventsResult> {
      const site = siteOrThrow(query.siteId);
      assertNoGoal(query, 'events');
      const timezone = site.settings.timezone;
      const rows = rawRows(query, { from: query.from, to: query.to });
      const base = visitorDays(visitorsByDay(rows, timezone));
      const custom = rows.filter((event) => event.type === 'event' && event.name !== undefined);
      const tallies = tallyBy(custom, (event) => event.name ?? '', timezone);
      const answered = sortEventRows(
        [...tallies].map(([key, tally]) => finishEventRow(key, tally, base)),
      );
      return {
        visitors: base,
        rows: answered.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT),
        rawOnly: true,
      };
    },

    async properties(query: PropertyQuery): Promise<PropertyResult> {
      const site = siteOrThrow(query.siteId);
      assertNoGoal(query, 'properties');
      const timezone = site.settings.timezone;
      const rows = rawRows(query, { from: query.from, to: query.to });
      const base = visitorDays(visitorsByDay(rows, timezone));
      const mine = rows.filter((event) => event.type === 'event' && event.name === query.event);

      const counts = new Map<string, number>();
      for (const event of mine) {
        for (const key of Object.keys(event.props ?? {})) {
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const properties = sortPropertyCounts(
        [...counts].map(([key, events]): PropertyCount => ({ key, events })),
      ).slice(0, MAX_PROPERTY_KEYS);
      const property = query.property ?? properties[0]?.key ?? null;
      if (property === null) {
        return { event: query.event, properties, property, visitors: base, rows: [], rawOnly: true };
      }
      // Own properties only: a name like constructor must read the page's
      // value, not something every object has.
      const valueOf = (event: StoredEvent): string =>
        event.props !== undefined && Object.hasOwn(event.props, property)
          ? (event.props[property] ?? '')
          : '';
      const tallies = tallyBy(mine, valueOf, timezone);
      const answered = sortEventRows(
        [...tallies].map(([key, tally]) => finishEventRow(key, tally, base)),
      );
      return {
        event: query.event,
        properties,
        property,
        visitors: base,
        rows: answered.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT),
        rawOnly: true,
      };
    },

    async goalStats(query: Query, goals: Goal[]): Promise<GoalStatsResult> {
      const site = siteOrThrow(query.siteId);
      const timezone = site.settings.timezone;
      const range: Range = { from: query.from, to: query.to };
      const counted = visitorsByDay(rawRows(query, range), timezone);
      const base = visitorDays(counted);
      return {
        visitors: base,
        rows: goals.map((goal) => ({
          goalId: goal.id,
          conversion: finishConversion(
            overlap(counted, rawConverters(query, goal, range, timezone)),
            base,
            goal,
          ),
        })),
        rawOnly: true,
      };
    },

    async funnelStats(query: Query, funnel: FunnelRead): Promise<FunnelResult> {
      siteOrThrow(query.siteId);
      assertNoGoal(query, 'funnel');
      assertFunnelSteps(funnel);
      const wantsBots = botSelector(query.filters);
      const split = splitVisitFilters(query.filters);
      const inRange = (event: StoredEvent): boolean =>
        event.siteId === query.siteId &&
        event.ts >= query.from &&
        event.ts < query.to &&
        event.bot === wantsBots;

      // The segment: a row of theirs matching every filter a row carries, and
      // a stay of theirs begun in the range matching every one only a stay does.
      const members = new Set<string>();
      for (const event of events) {
        if (inRange(event) && split.event.every((filter) => matchesFilter(event, filter))) {
          members.add(event.visitorId);
        }
      }
      if (split.stay.length > 0) {
        const stayed = new Set<string>();
        for (const session of sessions) {
          if (
            session.siteId === query.siteId &&
            session.startedAt >= query.from &&
            session.startedAt < query.to &&
            session.bot === wantsBots &&
            split.stay.every((filter) => matchesSessionFilter(session, filter))
          ) {
            stayed.add(session.visitorId);
          }
        }
        for (const visitorId of members) {
          if (!stayed.has(visitorId)) members.delete(visitorId);
        }
      }

      // The steps, among everybody: the filters choose the people, never the
      // rows that count as steps.
      const hitsOf = funnelHits(funnel.steps);
      const byVisit = funnel.window === 'visit';
      const rows = new Map<string, { row: FunnelRow; sessionId?: string }[]>();
      for (const event of events) {
        if (!inRange(event) || (byVisit && event.sessionId === undefined)) continue;
        const hits = hitsOf(event);
        if (!hits.includes(true)) continue;
        const list = rows.get(event.visitorId) ?? [];
        rows.set(event.visitorId, list);
        const entry: { row: FunnelRow; sessionId?: string } = { row: { ts: event.ts, hits } };
        if (event.sessionId !== undefined) entry.sessionId = event.sessionId;
        list.push(entry);
      }
      const windowMs = funnelWindowMs(funnel.window);
      const depths = new Map<number, number>();
      for (const visitorId of members) {
        const mine = (rows.get(visitorId) ?? [])
          .sort((left, right) => compareFunnelRows(left.row, right.row))
          .slice(0, MAX_FUNNEL_ROWS_PER_VISITOR);
        let depth = 0;
        if (byVisit) {
          const perVisit = new Map<string, FunnelRow[]>();
          for (const entry of mine) {
            const key = entry.sessionId ?? '';
            perVisit.set(key, [...(perVisit.get(key) ?? []), entry.row]);
          }
          for (const visit of perVisit.values()) {
            depth = Math.max(depth, funnelDepth(visit, windowMs));
          }
        } else {
          depth = funnelDepth(
            mine.map((entry) => entry.row),
            windowMs,
          );
        }
        depths.set(depth, (depths.get(depth) ?? 0) + 1);
      }
      return finishFunnel(depths, members.size, funnel.steps.length);
    },

    async journeys(query: JourneyQuery): Promise<JourneyResult> {
      siteOrThrow(query.siteId);
      assertNoGoal(query, 'journeys');
      const branches = journeyBranches(query);
      const wantsBots = botSelector(query.filters);
      const split = splitVisitFilters(query.filters);
      const inRange = (event: StoredEvent): boolean =>
        event.siteId === query.siteId &&
        event.ts >= query.from &&
        event.ts < query.to &&
        event.bot === wantsBots;

      // The visits: begun in the range, on the asked side of the bot line,
      // matching every filter only a stay carries.
      const visits = new Set<string>();
      for (const session of sessions) {
        if (
          session.siteId === query.siteId &&
          session.startedAt >= query.from &&
          session.startedAt < query.to &&
          session.bot === wantsBots &&
          split.stay.every((filter) => matchesSessionFilter(session, filter))
        ) {
          visits.add(session.id);
        }
      }
      // And, when a filter names something a row carries, with a row that
      // matches all of them.
      if (split.event.length > 0) {
        const matched = new Set<string>();
        for (const event of events) {
          if (
            event.sessionId !== undefined &&
            inRange(event) &&
            split.event.every((filter) => matchesFilter(event, filter))
          ) {
            matched.add(event.sessionId);
          }
        }
        for (const id of visits) {
          if (!matched.has(id)) visits.delete(id);
        }
      }

      const pages = new Map<string, { ts: number; path: string }[]>();
      for (const event of events) {
        if (event.type !== 'pageview' || event.sessionId === undefined) continue;
        if (!inRange(event) || !visits.has(event.sessionId)) continue;
        const list = pages.get(event.sessionId) ?? [];
        pages.set(event.sessionId, list);
        list.push({ ts: event.ts, path: event.path ?? '' });
      }
      const paths = [...pages.values()].map((list) =>
        journeyPath(
          list
            .sort(
              (left, right) =>
                left.ts - right.ts ||
                (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
            )
            .slice(0, JOURNEY_ROWS_PER_VISIT)
            .map((page) => page.path),
        ),
      );
      return finishJourneys(
        journeyStepCounts(paths, topJourneyPages(paths, branches)),
        branches,
      );
    },

    async realtime(siteId: string, sinceMs = REALTIME_WINDOW_MS): Promise<RealtimeSnapshot> {
      siteOrThrow(siteId);
      const at = now();
      // As far back as the caller asked, which defaults to the whole presence
      // window: the snapshot carries the people who were here a few minutes ago
      // beside the ones who are here now, and only the reader knows which of
      // the two it wants.
      return snapshotFrom(await presence.entries(siteId, at - sinceMs), at);
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

    visitorIdForUser(siteId: string, userId: string): Promise<string | null> {
      const newest = visitors
        .filter((row) => row.siteId === siteId && row.userId === userId)
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
      return Promise.resolve(newest?.id ?? null);
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

    async regroupRoutes(siteId: string): Promise<RegroupSummary> {
      const site = siteOrThrow(siteId);
      const timezone = site.settings.timezone;
      const matchers = routeMatchers(site.settings.routeGroups);
      // Every row of the site takes the route the rules give it now; then the
      // route rollups of every past day that still has rows, and only those.
      const today = dayKey(now(), timezone);
      const days = new Set<string>();
      let considered = 0;
      events = events.map((event) => {
        if (event.siteId !== siteId) return event;
        considered += 1;
        const day = dayKey(event.ts, timezone);
        if (day !== today) days.add(day);
        return withRoute(event, matchers);
      });
      for (const date of [...days].sort()) {
        rerollRoute(siteId, date, timezone);
      }
      const { routesChangedAt: _routesChangedAt, ...cleared } = site;
      bySiteId.set(siteId, cleared);
      return { siteId, events: considered, days: days.size };
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
