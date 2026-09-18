import type {
  AggregateResult,
  BreakdownResult,
  PurgeSummary,
  Query,
  RealtimeSnapshot,
  RollupSummary,
  TimeseriesResult,
  UserProfile,
  VisitorProfile,
} from './query.js';
import type { Site, StoredEvent } from './types.js';

// The one door to storage. Services ask this interface and never a driver, so
// an adapter can be swapped without touching a report, and every adapter is
// held to the same answers by the conformance suite in ./conformance.
//
// Reads split a range at the start of the site's current day: whole days
// before it come from the daily rollups, the rest comes from raw events. A
// past day nobody rolled up contributes nothing, and rollupDay is idempotent,
// so a backfill is the cure.
export interface AnalyticsStore {
  site(siteId: string): Promise<Site | null>;

  ingest(events: StoredEvent[]): Promise<void>;

  // Totals for the range, and for the comparison range when the query asks.
  aggregate(query: Query): Promise<AggregateResult>;

  // The same totals per bucket. interval defaults to 'day'; 'hour' reads raw
  // rows for the whole range and refuses one longer than MAX_HOUR_RANGE_DAYS.
  timeseries(query: Query): Promise<TimeseriesResult>;

  // The same totals per value of one dimension, biggest first.
  breakdown(query: Query): Promise<BreakdownResult>;

  // Who is here now: online counts, the pages and countries they are on, and
  // the visitors themselves.
  realtime(siteId: string): Promise<RealtimeSnapshot>;

  visitor(siteId: string, visitorId: string): Promise<VisitorProfile | null>;

  // The same profile for somebody an identify has named.
  user(siteId: string, userId: string): Promise<UserProfile | null>;

  // Roll one date key of the site's calendar into rollups_daily. Safe to run
  // twice: the second run writes the same numbers.
  rollupDay(siteId: string, date: string): Promise<RollupSummary>;

  // Delete raw rows older than an instant. Retention, and the erasure of one
  // person's history, both come through here.
  purge(siteId: string, before: number): Promise<PurgeSummary>;

  close(): Promise<void>;
}

export interface StoreOptions {
  // Injected so "today" is a fact a test can state.
  now?: () => number;
}
