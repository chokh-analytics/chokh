import type { BreakdownRow, Metrics } from './query.js';
import type { RollupDim } from './plan.js';
import { isBounce } from './session.js';
import type { StoredSession } from './types.js';

// The arithmetic behind every number, in one place, so two adapters cannot
// disagree about what a bounce rate is.

// What a rollup row holds and what a read accumulates on its way to Metrics.
export interface Totals {
  visitors: number;
  pageviews: number;
  visits: number;
  bounces: number;
  durationSum: number;
}

// One row of rollups_daily. The same shape in every adapter, because the key
// is what a year of history is filed under.
export interface RollupRecord extends Totals {
  siteId: string;
  date: string;
  dim: RollupDim;
  key: string;
}

export function zeroTotals(): Totals {
  return { visitors: 0, pageviews: 0, visits: 0, bounces: 0, durationSum: 0 };
}

export function addTotals(into: Totals, from: Partial<Totals>): void {
  into.visitors += from.visitors ?? 0;
  into.pageviews += from.pageviews ?? 0;
  into.visits += from.visits ?? 0;
  into.bounces += from.bounces ?? 0;
  into.durationSum += from.durationSum ?? 0;
}

// What one stay adds. A visit belongs to the day it began on, so an adapter
// picks its sessions by startedAt and then hands them here one at a time.
export function addSession(into: Totals, session: StoredSession): void {
  into.visits += 1;
  if (isBounce(session)) {
    into.bounces += 1;
  }
  into.durationSum += session.duration;
}

// A rate over nothing is not zero, it is unknown, so it is null.
export function finishMetrics(totals: Totals): Metrics {
  return {
    visitors: totals.visitors,
    pageviews: totals.pageviews,
    visits: totals.visits,
    bounces: totals.bounces,
    bounceRate: totals.visits === 0 ? null : totals.bounces / totals.visits,
    avgDurationMs: totals.visits === 0 ? null : totals.durationSum / totals.visits,
  };
}

// Biggest first, then the busiest, then alphabetical, so a tie never reorders
// itself between two reads or between two adapters.
export function sortBreakdownRows(rows: BreakdownRow[]): BreakdownRow[] {
  return rows.sort((left, right) => {
    if (right.metrics.visitors !== left.metrics.visitors) {
      return right.metrics.visitors - left.metrics.visitors;
    }
    if (right.metrics.pageviews !== left.metrics.pageviews) {
      return right.metrics.pageviews - left.metrics.pageviews;
    }
    return left.key.localeCompare(right.key);
  });
}
