import {
  DEFAULT_BREAKDOWN_LIMIT,
  SESSION_DIMENSIONS,
  SESSION_PATH_BY_DIMENSION,
  StoreQueryError,
  addEngagement,
  addTotals,
  assertEngageable,
  assertIntervalRange,
  assertNoGoal,
  botSelector,
  bucketIndexAt,
  bucketsBetween,
  comparisonRange,
  dayBounds,
  finishConversion,
  finishEngagement,
  finishEventRow,
  finishMetrics,
  needsRawForInterval,
  readPlan,
  rollupTotalSelector,
  sessionsAnswerFilters,
  sortBreakdownRows,
  sortEngagementRows,
  sortEventRows,
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
  type Goal,
  type GoalRead,
  type GoalStatsResult,
  type Interval,
  type Metrics,
  type PropertyCount,
  type PropertyQuery,
  type PropertyResult,
  type Query,
  type Range,
  type Site,
  type TimeseriesPoint,
  type TimeseriesResult,
  type Totals,
} from '@chokh/store';
import type { Pool } from 'pg';

import {
  conversionBreakdownSql,
  conversionTotalsSql,
  dayStarts,
  engagementSql,
  eventsSql,
  goalStatsSql,
  propertyKeysSql,
  propertyValuesSql,
  rawBreakdownSql,
  rawTotalsByBucketSql,
  rawTotalsSql,
  rollupBreakdownSql,
  rollupTotalsByDateSql,
  rollupTotalsSql,
  sessionBreakdownSql,
  sessionConversionBreakdownSql,
  sessionSourcedBreakdownSql,
  sessionTotalsByBucketSql,
  sessionTotalsSql,
  type Statement,
} from './reads.sql.js';
import type { Sites } from './sites.js';

// The reports that count: totals, series, breakdowns, time on page,
// conversions, custom events and their properties. Each plans the way every
// adapter does (readPlan: whole past days from the rollups, the rest from raw
// rows), asks the statements in reads.sql.ts, and finishes with the shared
// arithmetic, so a number means here what it means in the other adapters.

export type Reports = Pick<
  AnalyticsStore,
  'aggregate' | 'timeseries' | 'breakdown' | 'engagement' | 'events' | 'properties' | 'goalStats'
>;

export interface ReportDeps {
  pool: Pool;
  sites: Sites;
  now(): number;
}

type Counts = Record<string, number | string | null>;

export function createReports(deps: ReportDeps): Reports {
  const { pool, sites, now } = deps;

  async function rows<Row extends Counts = Counts>(statement: Statement): Promise<Row[]> {
    const result = await pool.query<Row>(statement.text, statement.values);
    return result.rows;
  }

  function totalsFrom(found: Counts[]): Totals {
    const totals = zeroTotals();
    for (const row of found) {
      addTotals(totals, row as Partial<Totals>);
    }
    return totals;
  }

  // Visits, bounces and time for a span, unless the query filtered on
  // something a stay spans rather than has, in which case they go unanswered.
  async function sessionTotals(query: Query, span: Range): Promise<Totals> {
    if (!sessionsAnswerFilters(query.filters)) {
      return zeroTotals();
    }
    return totalsFrom(
      await rows(sessionTotalsSql(query.siteId, span, botSelector(query.filters), query.filters)),
    );
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
    const wantsBots = botSelector(query.filters);
    // The rollups and each raw span are separate statements that need nothing
    // from one another, so they are asked together.
    const parts: Promise<Totals>[] = [];
    if (plan.days.length > 0) {
      const selector = rollupTotalSelector(query.filters);
      parts.push(
        rows(rollupTotalsSql(site.id, plan.days, selector.dim, selector.key)).then(totalsFrom),
      );
    }
    for (const span of plan.raw) {
      parts.push(
        rows(rawTotalsSql(site.id, span, timezone, wantsBots, query.filters)).then(totalsFrom),
        sessionTotals(query, span),
      );
    }
    const totals = zeroTotals();
    for (const part of await Promise.all(parts)) {
      addTotals(totals, part);
    }
    return finishMetrics(totals);
  }

  // A goal read is raw for the whole range, so this is one statement over it,
  // against the visitors the same raw rows counted.
  async function conversionFor(
    query: Query,
    goal: GoalRead,
    range: Range,
    site: Site,
    base: number,
  ): Promise<Conversion> {
    const [row] = await rows(
      conversionTotalsSql(
        site.id,
        range,
        site.settings.timezone,
        botSelector(query.filters),
        query.filters,
        goal,
      ),
    );
    return finishConversion(
      { visitors: Number(row?.visitors ?? 0), completions: Number(row?.completions ?? 0) },
      base,
      goal,
    );
  }

  // Converted visitors per row, from the table that counted the row's
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
    let found: Counts[] = [];
    if (!SESSION_DIMENSIONS.includes(dim)) {
      found = await rows(
        conversionBreakdownSql(site.id, span, timezone, dim, wantsBots, query.filters, goal),
      );
    } else if (sessionsAnswerFilters(query.filters)) {
      found = await rows(
        sessionConversionBreakdownSql(site.id, span, timezone, dim, wantsBots, query.filters, goal),
      );
    }
    return new Map(
      found.map((row) => [
        String(row.key),
        { visitors: Number(row.visitors), completions: Number(row.completions) },
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
    const wantsBots = botSelector(query.filters);
    // Visitors and pageviews come from events, except for the three dimensions
    // only a stay carries. Visits, bounces and time always come from stays.
    const fromSessions = SESSION_DIMENSIONS.includes(dim);
    const reads: Promise<Counts[]>[] = [];
    if (plan.days.length > 0) {
      reads.push(rows(rollupBreakdownSql(site.id, plan.days, dim)));
    }
    for (const span of plan.raw) {
      if (!fromSessions) {
        reads.push(rows(rawBreakdownSql(site.id, span, timezone, [dim], wantsBots, query.filters)));
      }
      if (SESSION_PATH_BY_DIMENSION[dim] === undefined || !sessionsAnswerFilters(query.filters)) {
        continue;
      }
      reads.push(
        rows(
          fromSessions
            ? sessionSourcedBreakdownSql(site.id, span, timezone, [dim], wantsBots, query.filters)
            : sessionBreakdownSql(site.id, span, [dim], wantsBots, query.filters),
        ),
      );
    }
    const goal = query.goal;
    const [found, converted] = await Promise.all([
      Promise.all(reads),
      goal === undefined ? null : conversionsByKey(query, goal, dim, site),
    ]);

    const byKey = new Map<string, Totals>();
    for (const row of found.flat()) {
      const key = String(row.key);
      const totals = byKey.get(key) ?? zeroTotals();
      addTotals(totals, row as Partial<Totals>);
      byKey.set(key, totals);
    }
    return sortBreakdownRows(
      [...byKey].map(([key, totals]): BreakdownRow => {
        const metrics = finishMetrics(totals);
        if (goal === undefined || converted === null) {
          return { key, metrics };
        }
        const reached = converted.get(key) ?? { visitors: 0, completions: 0 };
        return { key, metrics, conversion: finishConversion(reached, metrics.visitors, goal) };
      }),
    );
  }

  // The range's visitors under the filters, read raw: the denominator of every
  // raw-only report below.
  async function rawVisitors(query: Query, site: Site): Promise<number> {
    const [row] = await rows(
      rawTotalsSql(
        site.id,
        { from: query.from, to: query.to },
        site.settings.timezone,
        botSelector(query.filters),
        query.filters,
      ),
    );
    return Number(row?.visitors ?? 0);
  }

  return {
    async aggregate(query: Query): Promise<AggregateResult> {
      const site = await sites.siteOrThrow(query.siteId);
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
        // percentage and the line under it are answering one question.
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
      const site = await sites.siteOrThrow(query.siteId);
      assertNoGoal(query, 'timeseries');
      const interval: Interval = query.interval ?? 'day';
      assertIntervalRange(interval, query.from, query.to);
      const timezone = site.settings.timezone;
      // One statement per source for the whole range, not one per bucket.
      // Every row comes back under the instant its day, hour or minute began
      // and is folded into whichever bucket holds that instant.
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
        // Under a day, a visitor is distinct within the chart's own bucket;
        // from a day up, within a day of the site's calendar, the unit a
        // rollup counts in.
        const groupsOf = (span: Range): number[] =>
          needsRawForInterval(interval) ? starts : dayStarts(span, timezone);
        const wantsBots = botSelector(query.filters);
        const reads: Promise<void>[] = [];
        if (plan.days.length > 0) {
          const selector = rollupTotalSelector(query.filters);
          reads.push(
            rows(rollupTotalsByDateSql(site.id, plan.days, selector.dim, selector.key)).then(
              (found) => {
                for (const row of found) {
                  into(dayBounds(String(row.date), timezone).start, row as Partial<Totals>);
                }
              },
            ),
          );
        }
        for (const span of plan.raw) {
          const fold = (found: Counts[]): void => {
            for (const row of found) {
              into(Number(row.start), row as Partial<Totals>);
            }
          };
          reads.push(
            rows(
              rawTotalsByBucketSql(site.id, span, groupsOf(span), wantsBots, query.filters),
            ).then(fold),
          );
          if (sessionsAnswerFilters(query.filters)) {
            reads.push(
              rows(
                sessionTotalsByBucketSql(site.id, span, groupsOf(span), wantsBots, query.filters),
              ).then(fold),
            );
          }
        }
        await Promise.all(reads);

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
      const site = await sites.siteOrThrow(query.siteId);
      if (query.dim === undefined) {
        throw new StoreQueryError('MISSING_DIMENSION', 'A breakdown needs a dim');
      }
      const found = await breakdownFor(query, query.dim, site);
      return { dim: query.dim, rows: found.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT) };
    },

    async engagement(query: Query): Promise<EngagementResult> {
      await sites.siteOrThrow(query.siteId);
      assertNoGoal(query, 'engagement');
      const dim = assertEngageable(query.dim);
      // One statement over the whole range. A leave lives in events and
      // nowhere else, so there is no rollup half of this read to plan around.
      const tallies = new Map<string, EngagementTally>();
      for (const row of await rows(
        engagementSql(
          query.siteId,
          { from: query.from, to: query.to },
          dim,
          botSelector(query.filters),
          query.filters,
        ),
      )) {
        if (row.key === null || row.key === undefined) continue;
        const key = String(row.key);
        const tally = tallies.get(key) ?? zeroEngagement();
        addEngagement(tally, row as Partial<EngagementTally>);
        tallies.set(key, tally);
      }
      const answered = sortEngagementRows(
        [...tallies].map(([key, tally]) => finishEngagement(key, tally)),
      );
      return {
        dim,
        rows: answered.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT),
        rawOnly: true,
      };
    },

    async events(query: Query): Promise<EventsResult> {
      const site = await sites.siteOrThrow(query.siteId);
      assertNoGoal(query, 'events');
      const [base, found] = await Promise.all([
        rawVisitors(query, site),
        rows(
          eventsSql(
            site.id,
            { from: query.from, to: query.to },
            site.settings.timezone,
            botSelector(query.filters),
            query.filters,
          ),
        ),
      ]);
      const answered = sortEventRows(
        found.map((row) =>
          finishEventRow(
            String(row.key),
            { visitors: Number(row.visitors), events: Number(row.events) },
            base,
          ),
        ),
      );
      return {
        visitors: base,
        rows: answered.slice(0, query.limit ?? DEFAULT_BREAKDOWN_LIMIT),
        rawOnly: true,
      };
    },

    async properties(query: PropertyQuery): Promise<PropertyResult> {
      const site = await sites.siteOrThrow(query.siteId);
      assertNoGoal(query, 'properties');
      const span: Range = { from: query.from, to: query.to };
      const wantsBots = botSelector(query.filters);
      const [base, names] = await Promise.all([
        rawVisitors(query, site),
        rows(propertyKeysSql(site.id, span, wantsBots, query.filters, query.event)),
      ]);
      const properties = names.map(
        (row): PropertyCount => ({ key: String(row.key), events: Number(row.events) }),
      );
      const property = query.property ?? properties[0]?.key ?? null;
      if (property === null) {
        return { event: query.event, properties, property, visitors: base, rows: [], rawOnly: true };
      }
      const found = await rows(
        propertyValuesSql(
          site.id,
          span,
          site.settings.timezone,
          wantsBots,
          query.filters,
          query.event,
          property,
        ),
      );
      const answered = sortEventRows(
        found.map((row) =>
          finishEventRow(
            String(row.key),
            { visitors: Number(row.visitors), events: Number(row.events) },
            base,
          ),
        ),
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
      const site = await sites.siteOrThrow(query.siteId);
      const span: Range = { from: query.from, to: query.to };
      const [base, found] = await Promise.all([
        rawVisitors(query, site),
        goals.length === 0
          ? []
          : rows(
              goalStatsSql(
                site.id,
                span,
                site.settings.timezone,
                botSelector(query.filters),
                query.filters,
                goals,
              ),
            ),
      ]);
      const row = found[0];
      return {
        visitors: base,
        rows: goals.map((goal, index) => ({
          goalId: goal.id,
          conversion: finishConversion(
            {
              visitors: Number(row?.[`v${index}`] ?? 0),
              completions: Number(row?.[`n${index}`] ?? 0),
            },
            base,
            goal,
          ),
        })),
        rawOnly: true,
      };
    },
  };
}
