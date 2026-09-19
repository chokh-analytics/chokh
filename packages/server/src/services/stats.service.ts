import { csvDocument } from '../lib/csv.js';
import { attempt, type Outcome } from '../lib/store-error.js';
import type {
  AggregateResult,
  AnalyticsStore,
  BreakdownResult,
  EngagementResult,
  Metrics,
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
  return {
    ok: true,
    data: {
      dim: result.data.dim,
      body: csvDocument(
        CSV_HEADER,
        result.data.rows.map((row) => csvCells(row.key, row.metrics)),
      ),
    },
  };
}
