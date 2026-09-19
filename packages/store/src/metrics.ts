import type { BreakdownRow, EngagementRow, Metrics } from './query.js';
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

// The arithmetic of the engagement report, kept here for the same reason the
// rest of it is: two adapters must not disagree about what an average time on
// page is.
//
// Duration and scroll depth are counted separately from the leaves, because a
// leave beacon can carry one, both or neither: a page closed before the scroll
// listener ever fired has a time and no depth, and averaging it as a zero
// would say the visitor read none of a page they may have read all of.
export interface EngagementTally {
  durationSum: number;
  durationCount: number;
  scrollSum: number;
  scrollCount: number;
  leaves: number;
}

export function zeroEngagement(): EngagementTally {
  return { durationSum: 0, durationCount: 0, scrollSum: 0, scrollCount: 0, leaves: 0 };
}

export function addLeave(
  into: EngagementTally,
  leave: { duration?: number; scrollDepth?: number },
): void {
  into.leaves += 1;
  if (leave.duration !== undefined) {
    into.durationSum += leave.duration;
    into.durationCount += 1;
  }
  if (leave.scrollDepth !== undefined) {
    into.scrollSum += leave.scrollDepth;
    into.scrollCount += 1;
  }
}

export function addEngagement(into: EngagementTally, from: Partial<EngagementTally>): void {
  into.durationSum += from.durationSum ?? 0;
  into.durationCount += from.durationCount ?? 0;
  into.scrollSum += from.scrollSum ?? 0;
  into.scrollCount += from.scrollCount ?? 0;
  into.leaves += from.leaves ?? 0;
}

// An average over nothing is unknown, not zero, the same rule finishMetrics
// keeps for a bounce rate.
export function finishEngagement(key: string, tally: EngagementTally): EngagementRow {
  return {
    key,
    avgTimeOnPageMs: tally.durationCount === 0 ? null : tally.durationSum / tally.durationCount,
    avgScrollDepth: tally.scrollCount === 0 ? null : tally.scrollSum / tally.scrollCount,
    leaves: tally.leaves,
  };
}

// Most read first, then longest held, then alphabetical, so a tie never
// reorders itself between two reads or between two adapters.
export function sortEngagementRows(rows: EngagementRow[]): EngagementRow[] {
  return rows.sort((left, right) => {
    if (right.leaves !== left.leaves) {
      return right.leaves - left.leaves;
    }
    const leftTime = left.avgTimeOnPageMs ?? -1;
    const rightTime = right.avgTimeOnPageMs ?? -1;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return left.key.localeCompare(right.key);
  });
}
