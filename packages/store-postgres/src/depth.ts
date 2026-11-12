import {
  ACTIVITY_WINDOWS,
  ATTRIBUTION_DIMENSIONS,
  COHORT_INTERVALS,
  ERROR_GROUP_DEFAULT_LIMIT,
  StoreQueryError,
  activityPlan,
  addCohortCell,
  assertFunnelSteps,
  assertHealthRange,
  assertNoGoal,
  attributeConverter,
  attributionValue,
  botSelector,
  cohortPlan,
  comparePowerUsers,
  emptyActivityTally,
  finishActivity,
  finishAttribution,
  finishCohorts,
  finishFunnel,
  finishJourneys,
  foldCoverage,
  foldErrors,
  foldVitals,
  funnelWindowMs,
  journeyBranches,
  personFrom,
  powerMinDays,
  powerUserRow,
  splitVisitFilters,
  type ActivityPlan,
  type ActivityQuery,
  type ActivityResult,
  type ActivityTally,
  type AnalyticsStore,
  type AttributionCount,
  type AttributionQuery,
  type AttributionResult,
  type AttributionSource,
  type CohortCounts,
  type CohortQuery,
  type CohortResult,
  type CoverageQuery,
  type CoverageResult,
  type ErrorFacetTally,
  type ErrorSample,
  type ErrorsQuery,
  type ErrorsResult,
  type FunnelRead,
  type FunnelResult,
  type JourneyQuery,
  type JourneyResult,
  type JourneyStepCount,
  type PowerUserRow,
  type PowerUsersQuery,
  type PowerUsersResult,
  type Query,
  type Range,
  type Touch,
  type VitalCell,
  type VitalMetric,
  type VitalsQuery,
  type VitalsResult,
} from '@chokh/store';
import type { Pool } from 'pg';

import {
  activitySql,
  attributionSql,
  cohortSql,
  coverageSql,
  errorFacetsSql,
  errorMessagesSql,
  errorTotalsSql,
  funnelSql,
  journeysSql,
  powerUsersSql,
  vitalsSql,
} from './depth.sql.js';
import { knownGoal, knownQuery, type Statement } from './reads.sql.js';
import { visitorOf } from './rows.js';
import type { Sites } from './sites.js';

// Funnels, journeys, retention and health. Each asks one statement of
// depth.sql.ts (the errors report asks three, of rows that are rare) and
// finishes with the shared fold, so the report is assembled here the way the
// other adapters assemble it.

export type Depth = Pick<
  AnalyticsStore,
  | 'funnelStats'
  | 'journeys'
  | 'cohorts'
  | 'activity'
  | 'powerUsers'
  | 'attribution'
  | 'vitals'
  | 'errors'
  | 'coverage'
>;

export interface DepthDeps {
  pool: Pool;
  sites: Sites;
  now(): number;
}

type Row = Record<string, unknown>;

// What the activity statement answers, back into the tally the shared finish
// wants. A 'window' row is a change point: that window holds `people` from
// span day `day` until its next row, so each range day reads the latest change
// at or before it. A 'curve' row is the visitors active on exactly that many
// days of the range, and how many of them were returning.
export function activityTallyOf(rows: readonly Row[], plan: ActivityPlan): ActivityTally {
  const tally = emptyActivityTally(plan.days);
  const targets = new Map<number, number[]>([
    [ACTIVITY_WINDOWS[0], tally.dau],
    [ACTIVITY_WINDOWS[1], tally.wau],
    [ACTIVITY_WINDOWS[2], tally.mau],
  ]);
  const changes = new Map<number, [number, number][]>();
  for (const row of rows) {
    if (row.kind === 'curve') {
      const active = Number(row.a);
      const visitors = Number(row.b);
      tally.curve[active - 1] = (tally.curve[active - 1] ?? 0) + visitors;
      tally.visitors += visitors;
      tally.returning += Number(row.c);
      continue;
    }
    const width = Number(row.a);
    const list = changes.get(width) ?? [];
    list.push([Number(row.b), Number(row.c)]);
    changes.set(width, list);
  }
  for (const [width, list] of changes) {
    const target = targets.get(width);
    if (target === undefined) continue;
    list.sort((left, right) => left[0] - right[0]);
    let at = 0;
    let people = 0;
    for (let day = 0; day < plan.days; day += 1) {
      const spanDay = plan.offset + day;
      while (at < list.length && list[at]![0] <= spanDay) {
        people = list[at]![1];
        at += 1;
      }
      target[day] = people;
    }
  }
  return tally;
}

export function createDepth(deps: DepthDeps): Depth {
  const { pool, sites, now } = deps;

  async function ask(statement: Statement): Promise<Row[]> {
    const result = await pool.query<Row>(statement.text, statement.values);
    return result.rows;
  }

  return {
    async funnelStats(query: Query, funnel: FunnelRead): Promise<FunnelResult> {
      knownQuery(query);
      if (Array.isArray(funnel?.steps)) funnel.steps.forEach(knownGoal);
      const site = await sites.siteOrThrow(query.siteId);
      assertNoGoal(query, 'funnel');
      assertFunnelSteps(funnel);
      const rows = await ask(
        funnelSql(
          site.id,
          { from: query.from, to: query.to },
          botSelector(query.filters),
          splitVisitFilters(query.filters),
          funnel,
          funnelWindowMs(funnel.window),
        ),
      );
      const depths = rows.map((row): [number, number] => [Number(row.depth), Number(row.visitors)]);
      const segment = depths.reduce((total, [, visitors]) => total + visitors, 0);
      return finishFunnel(depths, segment, funnel.steps.length);
    },

    async journeys(query: JourneyQuery): Promise<JourneyResult> {
      knownQuery(query);
      const site = await sites.siteOrThrow(query.siteId);
      assertNoGoal(query, 'journeys');
      const branches = journeyBranches(query);
      const rows = await ask(
        journeysSql(
          site.id,
          { from: query.from, to: query.to },
          botSelector(query.filters),
          splitVisitFilters(query.filters),
          branches,
        ),
      );
      return finishJourneys(
        rows.map(
          (row): JourneyStepCount => ({
            column: Number(row.col),
            from: (row.node as string | null) ?? null,
            to: (row.after as string | null) ?? null,
            end: row.ending as JourneyStepCount['end'],
            visits: Number(row.visits),
          }),
        ),
        branches,
      );
    },

    async cohorts(query: CohortQuery): Promise<CohortResult> {
      if (!(COHORT_INTERVALS as readonly unknown[]).includes(query.interval)) {
        throw new StoreQueryError('UNSUPPORTED_INTERVAL', 'Cohorts are by week or by month');
      }
      const site = await sites.siteOrThrow(query.siteId);
      const plan = cohortPlan(query, site.settings.timezone);
      const counts: CohortCounts = new Map();
      if (plan.starts.length > 0) {
        for (const row of await ask(cohortSql(site.id, plan.span, plan.starts))) {
          addCohortCell(counts, Number(row.cohort), Number(row.bucket), Number(row.visitors));
        }
      }
      return finishCohorts(plan, counts, now());
    },

    async activity(query: ActivityQuery): Promise<ActivityResult> {
      const site = await sites.siteOrThrow(query.siteId);
      const plan = activityPlan(query, site.settings.timezone);
      const rows =
        plan.days === 0
          ? []
          : await ask(activitySql(site.id, plan.span, plan.starts, plan.offset, ACTIVITY_WINDOWS));
      return finishActivity(plan, activityTallyOf(rows, plan), now());
    },

    async powerUsers(query: PowerUsersQuery): Promise<PowerUsersResult> {
      const site = await sites.siteOrThrow(query.siteId);
      const plan = activityPlan(query, site.settings.timezone);
      const minDays = query.minDays ?? powerMinDays(plan.days);
      const people: PowerUserRow[] =
        plan.days === 0
          ? []
          : (
              await ask(
                powerUsersSql(
                  site.id,
                  plan.range,
                  // The range's own days: the span's, past the month before it.
                  plan.starts.slice(plan.offset),
                  minDays,
                  query.limit,
                ),
              )
            )
              .map((row) => {
                const visitor = visitorOf(row);
                return powerUserRow(personFrom(visitor), {
                  visitorId: visitor.id,
                  activeDays: Number(row.active_days),
                  visits: Number(row.visits),
                });
              })
              .sort(comparePowerUsers);
      return { people, days: plan.days, minDays, rawOnly: true };
    },

    async attribution(query: AttributionQuery): Promise<AttributionResult> {
      if (!(ATTRIBUTION_DIMENSIONS as readonly unknown[]).includes(query.dim)) {
        throw new StoreQueryError(
          'UNSUPPORTED_DIMENSION',
          'A conversion is attributed by a field a touch and a stay both carry',
        );
      }
      knownGoal(query.goal);
      const site = await sites.siteOrThrow(query.siteId);
      const range: Range = { from: query.from, to: query.to };
      const first = new Map<string, AttributionCount>();
      const last = new Map<string, AttributionCount>();
      for (const row of await ask(attributionSql(site.id, range, query.goal))) {
        // The stay the first conversion happened in, as a touch reads: absent
        // when the row had no stay, or the stay has aged out.
        let stay: AttributionSource | undefined;
        if (row.stayed === true) {
          stay = {};
          if (row.channel !== null) stay.channel = row.channel as string;
          if (row.referrer !== null) stay.referrer = row.referrer as string;
          if (row.utm !== null) stay.utm = row.utm as Record<string, string>;
          if (row.entry_path !== null) stay.entryPath = row.entry_path as string;
        }
        attributeConverter(first, last, {
          first: attributionValue((row.first_touch as Touch | null) ?? undefined, query.dim),
          last: attributionValue(stay, query.dim),
          completions: Number(row.completions),
        });
      }
      return finishAttribution(query.dim, query.goal, first, last);
    },

    async vitals(query: VitalsQuery): Promise<VitalsResult> {
      const site = await sites.siteOrThrow(query.siteId);
      assertHealthRange(query.from, query.to);
      const cells = new Map<string, VitalCell>();
      for (const row of await ask(
        vitalsSql(site.id, { from: query.from, to: query.to }, query.device),
      )) {
        const page = String(row.page);
        const device = String(row.device);
        const metric = row.metric as VitalMetric;
        const id = JSON.stringify([page, device, metric]);
        const cell = cells.get(id) ?? { page, device, metric, buckets: [] };
        cell.buckets.push({ q: Number(row.bucket), n: Number(row.n) });
        cells.set(id, cell);
      }
      return foldVitals([...cells.values()], query.sort ?? 'LCP');
    },

    async errors(query: ErrorsQuery): Promise<ErrorsResult> {
      const site = await sites.siteOrThrow(query.siteId);
      assertHealthRange(query.from, query.to);
      const range: Range = { from: query.from, to: query.to };
      const limit = query.limit ?? ERROR_GROUP_DEFAULT_LIMIT;
      // Three walks of rows that are rare: the biggest messages with their
      // samples, every row and visitor of the range, and then the people,
      // pages and browsers of those messages only.
      const [top, [totals]] = await Promise.all([
        ask(errorMessagesSql(site.id, range, limit)),
        ask(errorTotalsSql(site.id, range)),
      ]);
      const messages = top.map((row) => String(row.message));
      const facets = messages.length === 0 ? [] : await ask(errorFacetsSql(site.id, range, messages));
      const people = new Map<string, number>();
      const pages: ErrorFacetTally[] = [];
      const browsers: ErrorFacetTally[] = [];
      for (const row of facets) {
        const message = String(row.message);
        if (row.kind === 'people') {
          people.set(message, Number(row.n));
        } else {
          (row.kind === 'page' ? pages : browsers).push({
            message,
            key: String(row.key),
            count: Number(row.n),
          });
        }
      }
      return foldErrors(
        {
          total: Number(totals?.total ?? 0),
          visitors: Number(totals?.visitors ?? 0),
          groupsTotal: Number(top[0]?.messages ?? 0),
          messages: top.map((row) => {
            const sample: ErrorSample = {
              at: Number(row.at),
              page: String(row.page),
              browser: String(row.browser),
            };
            if (typeof row.frame === 'string') sample.frame = row.frame;
            if (typeof row.stack === 'string') sample.stack = row.stack;
            const message = String(row.message);
            return {
              message,
              count: Number(row.count),
              visitors: people.get(message) ?? 0,
              firstSeen: Number(row.first_seen),
              lastSeen: Number(row.last_seen),
              sample,
            };
          }),
          pages,
          browsers,
        },
        limit,
      );
    },

    async coverage(query: CoverageQuery): Promise<CoverageResult> {
      const site = await sites.siteOrThrow(query.siteId);
      assertHealthRange(query.from, query.to);
      const rows = await ask(coverageSql(site.id, { from: query.from, to: query.to }));
      return foldCoverage(
        rows.map((row) => ({
          userId: String(row.userId),
          server: row.server === true,
          browser: row.browser === true,
        })),
      );
    },
  };
}
