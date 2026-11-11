import { attempt, type Outcome } from '../lib/store-error.js';
import type {
  ActivityQuery,
  ActivityResult,
  AnalyticsStore,
  AttributionQuery,
  AttributionResult,
  CohortQuery,
  CohortResult,
} from '../store/AnalyticsStore.js';

// The retention reports (AN-PPL01) that are about traffic: cohorts, stickiness
// and attribution answer counts and keys and name nobody, so they are plain
// reports. The fourth, the power users, names people and lives with the other
// gated reads in people.service.ts.

export function cohorts(store: AnalyticsStore, query: CohortQuery): Promise<Outcome<CohortResult>> {
  return attempt(() => store.cohorts(query));
}

export function activity(
  store: AnalyticsStore,
  query: ActivityQuery,
): Promise<Outcome<ActivityResult>> {
  return attempt(() => store.activity(query));
}

export function attribution(
  store: AnalyticsStore,
  query: AttributionQuery,
): Promise<Outcome<AttributionResult>> {
  return attempt(() => store.attribution(query));
}
