import { attempt, type Outcome } from '../lib/store-error.js';
import type {
  AnalyticsStore,
  CoverageQuery,
  CoverageResult,
  ErrorsQuery,
  ErrorsResult,
  VitalsQuery,
  VitalsResult,
} from '../store/AnalyticsStore.js';

// The health reports (AN-VIT01). All three answer counts, percentiles and
// scrubbed text and name nobody, so they are plain reports on read:stats: the
// error report carries no visitor, user, address or place per row, only how
// many and where (health.ts in the store).

export function vitals(store: AnalyticsStore, query: VitalsQuery): Promise<Outcome<VitalsResult>> {
  return attempt(() => store.vitals(query));
}

export function errors(store: AnalyticsStore, query: ErrorsQuery): Promise<Outcome<ErrorsResult>> {
  return attempt(() => store.errors(query));
}

export function coverage(
  store: AnalyticsStore,
  query: CoverageQuery,
): Promise<Outcome<CoverageResult>> {
  return attempt(() => store.coverage(query));
}
