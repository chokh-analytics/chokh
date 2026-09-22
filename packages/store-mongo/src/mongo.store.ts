import {
  DEFAULT_BREAKDOWN_LIMIT,
  MAX_GOALS_PER_SITE,
  PROFILE_EVENT_LIMIT,
  REALTIME_WINDOW_MS,
  ROLLED_DIMENSIONS,
  ROLLUP_TOTAL_DIM,
  SESSION_DIMENSIONS,
  SESSION_PATH_BY_DIMENSION,
  StoreQueryError,
  addEngagement,
  addTotals,
  assertEngageable,
  assertNoGoal,
  assertFilterable,
  assertIntervalRange,
  botSelector,
  bucketIndexAt,
  bucketsBetween,
  comparisonRange,
  createMemoryPresence,
  dayBounds,
  finishConversion,
  finishEngagement,
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
  sortEngagementRows,
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
  type Goal,
  type GoalRead,
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
  type AccountStore,
  type ApiKeyRecord,
  type AuditRecord,
  type SitePatch,
  type StoredApiKey,
  type StoredTeam,
  type StoredUser,
  type TeamMember,
  type UserPatch,
} from '@chokh/store';
import {
  MongoClient,
  MongoServerError,
  type AnyBulkWriteOperation,
  type Db,
  type Document,
} from 'mongodb';

import {
  conversionBreakdownPipeline,
  conversionTotalsPipeline,
  engagementPipeline,
  rawTotalsByBucketPipeline,
  rollupTotalsByDatePipeline,
  sessionTotalsByBucketPipeline,
  rawBreakdownPipeline,
  rawTotalsPipeline,
  rollupBreakdownPipeline,
  rollupTotalsPipeline,
  sessionBreakdownPipeline,
  sessionConversionBreakdownPipeline,
  sessionSourcedBreakdownPipeline,
  sessionTotalsPipeline,
} from './pipelines.js';
import {
  API_KEYS,
  AUDIT_LOG,
  EVENTS,
  GOALS,
  ROLLUPS_DAILY,
  SESSIONS,
  SITES,
  TEAMS,
  USERS,
  VISITORS,
} from './schema.js';

// The MongoDB adapter. Everything below reads and writes through aggregation
// pipelines built in pipelines.ts; nothing here creates an index, because only
// `migrate --apply` does that.

const DAY_MS = 24 * 60 * 60 * 1000;
// A site row is read on every ingest to stamp the retention. It changes about
// never, so a short cache keeps the write path off the sites collection
// without letting a settings change wait longer than a coffee.
const SITE_CACHE_MS = 60_000;

export interface MongoStore extends AnalyticsStore, AccountStore {
  db: Db;
}

// Why a site cannot have an empty domain list, said once because both writes
// refuse it: the unique multikey index on sites.domains stores one null key for
// an empty array, so the second domainless site collides with the first, and a
// site with no domain could not pass the collector's origin check anyway.
const NO_DOMAIN =
  'A site needs at least one domain: the unique index on sites.domains cannot hold two empty lists';

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
  const users = db.collection<StoredUser>(USERS);
  const teams = db.collection<StoredTeam>(TEAMS);
  const apiKeys = db.collection<StoredApiKey>(API_KEYS);
  const auditLog = db.collection<AuditRecord>(AUDIT_LOG);
  const goals = db.collection<Goal>(GOALS);

  const siteCache = new Map<string, { site: Site | null; until: number }>();

  async function readSite(siteId: string): Promise<Site | null> {
    const cached = siteCache.get(siteId);
    if (cached !== undefined && cached.until > now()) {
      return cached.site;
    }
    const doc = await sites.findOne({ id: siteId }, { projection: { _id: 0 } });
    const site: Site | null = doc === null ? null : siteOf(doc);
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
      ...(query.goal === undefined ? {} : { goal: query.goal }),
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

  // A goal read is raw for the whole range, so this is one aggregation over it,
  // against the visitors the same raw rows counted.
  async function conversionFor(
    query: Query,
    goal: GoalRead,
    range: Range,
    site: Site,
    base: number,
  ): Promise<Conversion> {
    const [row] = await events
      .aggregate(
        conversionTotalsPipeline(
          site.id,
          range,
          site.settings.timezone,
          botSelector(query.filters),
          query.filters,
          goal,
        ),
      )
      .toArray();
    return finishConversion(
      {
        visitors: (row?.visitors as number | undefined) ?? 0,
        completions: (row?.completions as number | undefined) ?? 0,
      },
      base,
      goal,
    );
  }

  // Converted visitors per row, from the collection that counted the row's
  // visitors. Empty when the session side cannot answer the filters, which is
  // when the breakdown itself has no rows from it either.
  async function conversionsByKey(
    query: Query,
    goal: GoalRead,
    dim: Dimension,
    site: Site,
  ): Promise<Map<string, { visitors: number; completions: number }>> {
    const span: Range = { from: query.from, to: query.to };
    const timezone = site.settings.timezone;
    const wantsBots = botSelector(query.filters);
    let rows: Document[] = [];
    if (!SESSION_DIMENSIONS.includes(dim)) {
      rows = await events
        .aggregate(
          conversionBreakdownPipeline(site.id, span, timezone, dim, wantsBots, query.filters, goal),
        )
        .toArray();
    } else if (sessionsAnswerFilters(query.filters)) {
      rows = await sessions
        .aggregate(
          sessionConversionBreakdownPipeline(
            site.id,
            span,
            timezone,
            dim,
            wantsBots,
            query.filters,
            goal,
          ),
        )
        .toArray();
    }
    return new Map(
      rows.map((row) => [
        String(row._id),
        { visitors: row.visitors as number, completions: row.completions as number },
      ]),
    );
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
      ...(query.goal === undefined ? {} : { goal: query.goal }),
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
    const goal = query.goal;
    const converted = goal === undefined ? null : await conversionsByKey(query, goal, dim, site);
    return sortBreakdownRows(
      [...byKey].map(([key, totals]): BreakdownRow => {
        const metrics = finishMetrics(totals);
        if (goal === undefined || converted === null) {
          return { key, metrics };
        }
        const found = converted.get(key) ?? { visitors: 0, completions: 0 };
        return { key, metrics, conversion: finishConversion(found, metrics.visitors, goal) };
      }),
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

    async createSite(site: Site): Promise<void> {
      if (site.domains.length === 0) {
        throw new StoreQueryError('DOMAIN_REQUIRED', NO_DOMAIN);
      }
      if ((await sites.countDocuments({ id: site.id }, { limit: 1 })) > 0) {
        throw new StoreQueryError('SITE_EXISTS', `A site already answers to ${site.id}`);
      }
      const clash = await sites.findOne({ domains: { $in: site.domains } });
      if (clash !== null) {
        const taken = site.domains.find((domain) => clash.domains.includes(domain));
        throw new StoreQueryError('DOMAIN_TAKEN', `${taken} already belongs to another site`);
      }
      await sites.insertOne({ ...site });
      siteCache.delete(site.id);
    },

    async updateSite(siteId: string, patch: SitePatch): Promise<Site> {
      const current = await siteOrThrow(siteId);
      const domains = patch.domains ?? current.domains;
      if (domains.length === 0) {
        throw new StoreQueryError('DOMAIN_REQUIRED', NO_DOMAIN);
      }
      const clash = await sites.findOne({ id: { $ne: siteId }, domains: { $in: domains } });
      if (clash !== null) {
        const taken = domains.find((domain) => clash.domains.includes(domain));
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
      await sites.replaceOne({ id: siteId }, updated);
      siteCache.delete(siteId);
      return updated;
    },

    async createUser(user: StoredUser): Promise<void> {
      const email = user.email.toLowerCase();
      if ((await users.countDocuments({ email }, { limit: 1 })) > 0) {
        throw new StoreQueryError('EMAIL_EXISTS', 'An account already uses that address');
      }
      await users.insertOne({ ...user, email });
    },

    async updateUser(userId: string, patch: UserPatch): Promise<void> {
      const set: Partial<StoredUser> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.passwordHash !== undefined) set.passwordHash = patch.passwordHash;
      if (patch.lastLoginAt !== undefined) set.lastLoginAt = patch.lastLoginAt;
      if (Object.keys(set).length === 0) {
        return;
      }
      const result = await users.updateOne({ id: userId }, { $set: set });
      if (result.matchedCount === 0) {
        throw new StoreQueryError('UNKNOWN_USER', `No account answers to ${userId}`);
      }
    },

    userById(userId: string): Promise<StoredUser | null> {
      return users.findOne({ id: userId }, { projection: { _id: 0 } });
    },

    userByEmail(email: string): Promise<StoredUser | null> {
      return users.findOne({ email: email.toLowerCase() }, { projection: { _id: 0 } });
    },

    userCount(): Promise<number> {
      return users.countDocuments();
    },

    async createTeam(team: StoredTeam): Promise<void> {
      if ((await teams.countDocuments({ id: team.id }, { limit: 1 })) > 0) {
        throw new StoreQueryError('TEAM_EXISTS', `A team already answers to ${team.id}`);
      }
      await teams.insertOne({ ...team });
    },

    team(teamId: string): Promise<StoredTeam | null> {
      return teams.findOne({ id: teamId }, { projection: { _id: 0 } });
    },

    teamsForUser(userId: string): Promise<StoredTeam[]> {
      return teams.find({ 'members.userId': userId }, { projection: { _id: 0 } }).toArray();
    },

    async setTeamMember(teamId: string, member: TeamMember): Promise<StoredTeam> {
      const team = await teams.findOne({ id: teamId }, { projection: { _id: 0 } });
      if (team === null) {
        throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
      }
      const members = team.members.filter((row) => row.userId !== member.userId);
      members.push({ ...member });
      await teams.updateOne({ id: teamId }, { $set: { members } });
      return { ...team, members };
    },

    async createApiKey(key: StoredApiKey): Promise<void> {
      if ((await apiKeys.countDocuments({ keyHash: key.keyHash }, { limit: 1 })) > 0) {
        throw new StoreQueryError('KEY_EXISTS', 'That key already exists');
      }
      await apiKeys.insertOne({ ...key });
    },

    apiKeyByHash(keyHash: string): Promise<StoredApiKey | null> {
      return apiKeys.findOne({ keyHash }, { projection: { _id: 0 } });
    },

    apiKeys(siteId: string): Promise<ApiKeyRecord[]> {
      // A hash is still a secret, so a list of keys is not a list of them.
      return apiKeys
        .find({ siteId }, { projection: { _id: 0, keyHash: 0 } })
        .toArray() as Promise<ApiKeyRecord[]>;
    },

    async deleteApiKey(siteId: string, keyId: string): Promise<boolean> {
      const result = await apiKeys.deleteOne({ siteId, id: keyId });
      return result.deletedCount > 0;
    },

    goals(siteId: string): Promise<Goal[]> {
      // The {siteId, id} unique index answers the site by its prefix. At most
      // fifty rows, so the order is set in memory rather than by an index of
      // its own.
      return goals
        .find({ siteId }, { projection: { _id: 0 } })
        .toArray()
        .then((rows) => rows.sort((left, right) => left.createdAt - right.createdAt));
    },

    goal(siteId: string, goalId: string): Promise<Goal | null> {
      return goals.findOne({ siteId, id: goalId }, { projection: { _id: 0 } });
    },

    async createGoal(goal: Goal): Promise<void> {
      await siteOrThrow(goal.siteId);
      if ((await goals.countDocuments({ siteId: goal.siteId })) >= MAX_GOALS_PER_SITE) {
        throw new StoreQueryError('GOAL_LIMIT', `A site can have at most ${MAX_GOALS_PER_SITE} goals`);
      }
      try {
        await goals.insertOne({ ...goal });
      } catch (error) {
        // The id is derived from the question, so the unique index is what
        // refuses the same question asked twice, with no read before the write
        // for two requests to race past.
        if (error instanceof MongoServerError && error.code === 11000) {
          throw new StoreQueryError('GOAL_EXISTS', 'A goal already asks that question');
        }
        throw error;
      }
    },

    async deleteGoal(siteId: string, goalId: string): Promise<boolean> {
      const result = await goals.deleteOne({ siteId, id: goalId });
      return result.deletedCount > 0;
    },

    async audit(row: AuditRecord): Promise<void> {
      await auditLog.insertOne({ ...row });
    },

    auditTrail(siteId: string, from: number, to: number): Promise<AuditRecord[]> {
      return auditLog
        .find({ siteId, ts: { $gte: from, $lt: to } }, { projection: { _id: 0 } })
        .sort({ ts: 1 })
        .toArray();
    },

    site(siteId: string): Promise<Site | null> {
      return readSite(siteId);
    },

    async sites(): Promise<Site[]> {
      const docs = await sites.find({}, { projection: { _id: 0 } }).toArray();
      return docs.map(siteOf);
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
        //
        // The two reads go together: they are different collections and neither
        // needs the other's answer, so waiting for them one after the other buys
        // nothing and costs a round trip. On a laptop against a local mongod that
        // round trip is most of a millisecond; from a droplet to Atlas it is
        // several.
        const [open, visitor] = await Promise.all([
          sessions.findOne<StoredSession>(
            { siteId, visitorId },
            { projection: { _id: 0, expiresAt: 0 }, sort: { startedAt: -1 } },
          ),
          visitors.findOne<StoredVisitor>(
            { siteId, id: visitorId },
            { projection: { _id: 0, expiresAt: 0 } },
          ),
        ]);
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

        // Only the stays a browser was seen in. An event an application sent
        // server side moves the stay and puts nobody online.
        const entries = folded.live
          .map((session) => presenceEntryOf(session))
          .filter((entry): entry is PresenceEntry => entry !== null);
        if (entries.length > 0) {
          live.push({ siteId, entries });
        }
      }

      // Three collections and a presence set, none of which needs another's
      // answer, so they go together for the same reason the two reads above do.
      // There is no ordering to preserve: nothing about a batch is atomic across
      // collections either way, and a reader that catches it half written sees a
      // session whose events are a millisecond behind rather than a wrong number.
      await Promise.all([
        docs.length > 0 ? events.insertMany(docs, { ordered: false }) : undefined,
        sessionWrites.length > 0
          ? sessions.bulkWrite(sessionWrites, { ordered: false })
          : undefined,
        visitorWrites.length > 0
          ? visitors.bulkWrite(visitorWrites, { ordered: false })
          : undefined,
        ...live.map(({ siteId, entries }) => presence.touch(siteId, entries)),
      ]);
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
      if (query.goal !== undefined) {
        result.conversion = await conversionFor(
          query,
          query.goal,
          range,
          site,
          result.metrics.visitors,
        );
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
        result.previous = await metricsFor(query, previousRange, site);
        if (query.goal !== undefined) {
          result.previousConversion = await conversionFor(
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
      const site = await siteOrThrow(query.siteId);
      assertFilterable(query.filters);
      assertNoGoal(query, 'timeseries');
      const interval: Interval = query.interval ?? 'day';
      assertIntervalRange(interval, query.from, query.to);
      const timezone = site.settings.timezone;
      // One query per source for the whole range, not one per bucket. Every row
      // comes back keyed by the instant its day or hour began, and is folded into
      // whichever bucket holds that instant. See the pipelines for why the
      // arithmetic is unchanged.
      const series = async (range: Range): Promise<TimeseriesPoint[]> => {
        const starts = bucketsBetween(range.from, range.to, interval, timezone);
        const buckets = starts.map(() => zeroTotals());
        const into = (at: number, row: Partial<Totals>): void => {
          const index = bucketIndexAt(starts, at, range.to);
          if (index !== -1) {
            addTotals(buckets[index]!, row);
          }
        };

        // The interval is part of the plan, not a detail of the fold. An
        // hourly or minute series reads raw rows for the whole range, because
        // a rollup cannot say which hour of its day anything happened in.
        const plan = readPlan({
          from: range.from,
          to: range.to,
          todayStart: startOfDay(now(), timezone),
          timezone,
          filters: query.filters,
          interval,
        });
        if (plan.days.length > 0) {
          const selector = rollupTotalSelector(query.filters);
          for (const row of await rollups
            .aggregate(rollupTotalsByDatePipeline(site.id, plan.days, selector.dim, selector.key))
            .toArray()) {
            into(dayBounds(String(row._id), timezone).start, row as Partial<Totals>);
          }
        }
        const wantsBots = botSelector(query.filters);
        for (const span of plan.raw) {
          for (const row of await events
            .aggregate(
              rawTotalsByBucketPipeline(
                site.id,
                span,
                timezone,
                interval,
                wantsBots,
                query.filters,
              ),
            )
            .toArray()) {
            into(bucketOf(row._id), row as Partial<Totals>);
          }
          if (!sessionsAnswerFilters(query.filters)) {
            continue;
          }
          for (const row of await sessions
            .aggregate(
              sessionTotalsByBucketPipeline(
                site.id,
                span,
                timezone,
                interval,
                wantsBots,
                query.filters,
              ),
            )
            .toArray()) {
            into(bucketOf(row._id), row as Partial<Totals>);
          }
        }

        return starts.map((start, index) => ({
          start,
          end: starts[index + 1] ?? range.to,
          metrics: finishMetrics(buckets[index]!),
        }));
      };

      const range: Range = { from: query.from, to: query.to };
      const result: TimeseriesResult = { interval, points: await series(range), previous: null };
      if (query.compare !== undefined) {
        result.previous = await series(comparisonRange(range, query.compare, timezone, interval));
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

    async engagement(query: Query): Promise<EngagementResult> {
      await siteOrThrow(query.siteId);
      assertFilterable(query.filters);
      assertNoGoal(query, 'engagement');
      const dim = assertEngageable(query.dim);
      // One aggregation over the whole range. A leave lives in events and
      // nowhere else, so there is no rollup half of this read to plan around.
      const tallies = new Map<string, EngagementTally>();
      for (const row of await events
        .aggregate(
          engagementPipeline(
            query.siteId,
            { from: query.from, to: query.to },
            dim,
            botSelector(query.filters),
            query.filters,
          ),
        )
        .toArray()) {
        if (row._id === null || row._id === undefined) continue;
        const key = String(row._id);
        const tally = tallies.get(key) ?? zeroEngagement();
        addEngagement(tally, row as Partial<EngagementTally>);
        tallies.set(key, tally);
      }
      const rows = sortEngagementRows(
        [...tallies].map(([key, tally]) => finishEngagement(key, tally)),
      );
      return { dim, rows: rows.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT), rawOnly: true };
    },

    async realtime(siteId: string, sinceMs = REALTIME_WINDOW_MS): Promise<RealtimeSnapshot> {
      await siteOrThrow(siteId);
      const at = now();
      // As far back as the caller asked, which defaults to the whole presence
      // window: the snapshot carries the people who were here a few minutes ago
      // beside the ones who are here now, and only the reader knows which of
      // the two it wants.
      return snapshotFrom(await presence.entries(siteId, at - sinceMs), at);
    },

    async visitor(siteId: string, visitorId: string): Promise<VisitorProfile | null> {
      const found = await profile({ siteId, visitorId }, { siteId, id: visitorId });
      return found === null ? null : { siteId, visitorId, ...found.body };
    },

    async user(siteId: string, userId: string): Promise<UserProfile | null> {
      const found = await profile({ siteId, userId }, { siteId, userId });
      return found === null ? null : { siteId, visitorIds: found.visitorIds, ...found.body, userId };
    },

    async visitorIdForUser(siteId: string, userId: string): Promise<string | null> {
      const newest = await visitors.findOne(
        { siteId, userId },
        { projection: { _id: 0, id: 1 }, sort: { lastSeenAt: -1 } },
      );
      return newest?.id ?? null;
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

// A site row as the contract describes it, and nothing the driver added. One
// function because two reads answer with a site and both have to carry teamId:
// a missing team is a site nobody can read.
function siteOf(doc: Site): Site {
  const site: Site = {
    id: doc.id,
    name: doc.name,
    domains: doc.domains,
    settings: doc.settings,
  };
  if (doc.teamId !== undefined) site.teamId = doc.teamId;
  return site;
}

// A $dateTrunc group key comes back as a Date. Read as an instant, so the
// caller can fold it into a bucket without knowing which it was.
function bucketOf(id: unknown): number {
  return id instanceof Date ? id.getTime() : Number(id);
}

function requiredUri(uri: string | undefined): string {
  if (uri === undefined || uri === '') {
    throw new Error('createMongoStore needs a uri or a client');
  }
  return uri;
}
