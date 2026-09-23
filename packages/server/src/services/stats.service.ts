import { csvDocument } from '../lib/csv.js';
import { attempt, type Outcome } from '../lib/store-error.js';
import type {
  AggregateResult,
  AnalyticsStore,
  BreakdownResult,
  Conversion,
  EngagementResult,
  EventsResult,
  FunnelRead,
  FunnelResult,
  Goal,
  GoalStatsResult,
  JourneyQuery,
  JourneyResult,
  Metrics,
  PropertyQuery,
  PropertyResult,
  Query,
  TimeseriesResult,
} from '../store/AnalyticsStore.js';

// The reports. Every one of them is the store's own query shape straight through,
// because the query shape was designed to be the API's: from, to, filters,
// compare, interval, dim, limit, and nothing a route has to translate.
//
// What this layer adds is the refusal. A range the store cannot answer hourly, a
// filter raw rows cannot carry, a breakdown with no dimension: all of those come
// back as codes, and attempt turns them into statuses without any controller
// learning what a StoreQueryError is.

export function aggregate(store: AnalyticsStore, query: Query): Promise<Outcome<AggregateResult>> {
  return attempt(() => store.aggregate(query));
}

export function timeseries(store: AnalyticsStore, query: Query): Promise<Outcome<TimeseriesResult>> {
  return attempt(() => store.timeseries(query));
}

export function breakdown(store: AnalyticsStore, query: Query): Promise<Outcome<BreakdownResult>> {
  return attempt(() => store.breakdown(query));
}

export function engagement(
  store: AnalyticsStore,
  query: Query,
): Promise<Outcome<EngagementResult>> {
  return attempt(() => store.engagement(query));
}

export function events(store: AnalyticsStore, query: Query): Promise<Outcome<EventsResult>> {
  return attempt(() => store.events(query));
}

export function properties(
  store: AnalyticsStore,
  query: PropertyQuery,
): Promise<Outcome<PropertyResult>> {
  return attempt(() => store.properties(query));
}

export function goalStats(
  store: AnalyticsStore,
  query: Query,
  goals: Goal[],
): Promise<Outcome<GoalStatsResult>> {
  return attempt(() => store.goalStats(query, goals));
}

// The columns a breakdown export has, in one place, so the CSV and the JSON
// answer the same numbers under the same names.
const CSV_HEADER = [
  'key',
  'visitors',
  'pageviews',
  'visits',
  'bounces',
  'bounce_rate',
  'avg_duration_ms',
] as const;

// Four more when the export was asked with a goal, the same four the JSON row
// carries under conversion. Only then: a file with a conversion rate column
// full of blanks reads as a goal nobody reached.
const CONVERSION_HEADER = ['converted_visitors', 'completions', 'conversion_rate', 'value'] as const;

function conversionCells(conversion: Conversion | undefined): (number | null)[] {
  return [
    conversion?.visitors ?? 0,
    conversion?.completions ?? 0,
    conversion?.rate ?? null,
    conversion?.value ?? null,
  ];
}

function csvCells(key: string, metrics: Metrics): (string | number | null)[] {
  return [
    key,
    metrics.visitors,
    metrics.pageviews,
    metrics.visits,
    metrics.bounces,
    // Null rather than zero, the same as the JSON: a rate over no visits is
    // unknown, and a spreadsheet averaging a column of invented zeroes is how a
    // report ends up wrong.
    metrics.bounceRate,
    metrics.avgDurationMs,
  ];
}

export async function breakdownCsv(
  store: AnalyticsStore,
  query: Query,
): Promise<Outcome<{ dim: string; body: string }>> {
  const result = await breakdown(store, query);
  if (!result.ok) {
    return result;
  }
  const withGoal = query.goal !== undefined;
  return {
    ok: true,
    data: {
      dim: result.data.dim,
      body: csvDocument(
        withGoal ? [...CSV_HEADER, ...CONVERSION_HEADER] : CSV_HEADER,
        result.data.rows.map((row) =>
          withGoal
            ? [...csvCells(row.key, row.metrics), ...conversionCells(row.conversion)]
            : csvCells(row.key, row.metrics),
        ),
      ),
    },
  };
}

export function funnelStats(
  store: AnalyticsStore,
  query: Query,
  funnel: FunnelRead,
): Promise<Outcome<FunnelResult>> {
  return attempt(() => store.funnelStats(query, funnel));
}

export function journeys(
  store: AnalyticsStore,
  query: JourneyQuery,
): Promise<Outcome<JourneyResult>> {
  return attempt(() => store.journeys(query));
}
