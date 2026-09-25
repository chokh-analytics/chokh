import { attempt, type Outcome } from '../lib/store-error.js';
import type {
  AggregateResult,
  AnalyticsStore,
  BreakdownResult,
  EngagementResult,
  EventsResult,
  FunnelRead,
  FunnelResult,
  Goal,
  GoalStatsResult,
  JourneyQuery,
  JourneyResult,
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
