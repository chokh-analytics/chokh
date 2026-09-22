import {
  BOT_DIMENSION,
  botSelector,
  needsRawRows,
  type Dimension,
  type Filter,
  type GoalMatch,
  type Range,
} from './query.js';
import { addDays, dayBounds, dayKey, type Interval } from './time.js';

// Where a read gets its rows. Whole days of the site's calendar that are
// already behind us come from rollups_daily; the partial day at either edge,
// and everything from the start of today, comes from raw events. Both adapters
// plan the same way, so the MongoDB answer and the in-memory answer are drawn
// from the same rows.

// rollups_daily keeps the totals of a day under this dim, so a read that wants
// no breakdown has one row per day to fetch rather than a dimension to sum.
export const ROLLUP_TOTAL_DIM = 'total';

export type RollupDim = Dimension | typeof ROLLUP_TOTAL_DIM;

export interface ReadPlan {
  // Rollup date keys, whole days only.
  days: string[];
  // Spans read from raw events.
  raw: Range[];
}

// An interval finer than a day cannot be answered from a rollup.
//
// A daily rollup holds one number for a whole day and nothing that says which
// hour any of it happened in. An adapter that plans a range without knowing the
// interval, finds a whole rolled day and folds that day's total into the bucket
// the day begins in draws every visit of the 17th at midnight: a Yesterday
// chart that is a single spike, and a 7 day hourly chart whose first day is one.
//
// So the plan is the interval's business, and it is decided here rather than in
// an adapter, because two adapters reaching different conclusions about where a
// bucket's rows live is exactly how one of them draws a different chart from
// the other. What this costs is raw rows for the whole range, which is what the
// caps in query.ts are for: an hourly read is capped at 7 days and a minute one
// at 3 hours, against a raw retention of 180.
export const SUB_DAY_INTERVALS: readonly Interval[] = ['minute', 'hour'];

export function needsRawForInterval(interval: Interval | undefined): boolean {
  return interval !== undefined && SUB_DAY_INTERVALS.includes(interval);
}

export interface ReadPlanOptions {
  from: number;
  to: number;
  todayStart: number;
  timezone: string;
  filters?: Filter[];
  dim?: Dimension;
  // The bucket size the caller is going to fold these rows into. Omitted means
  // a day or coarser, which a rollup can answer.
  interval?: Interval;
  // A read counted against a goal is raw for the whole range, both halves of
  // it: see conversionMatcher in query.ts.
  goal?: GoalMatch;
}

export function readPlan(options: ReadPlanOptions): ReadPlan {
  const { from, to, todayStart, timezone } = options;
  if (to <= from) {
    return { days: [], raw: [] };
  }
  const allRaw: ReadPlan = { days: [], raw: [{ from, to }] };
  if (
    options.goal !== undefined ||
    needsRawRows(options.filters, options.dim) ||
    needsRawForInterval(options.interval)
  ) {
    return allRaw;
  }

  const rolledLimit = Math.min(to, todayStart);
  if (rolledLimit <= from) {
    return allRaw;
  }

  // The first whole day at or after from.
  const startKey = dayKey(from, timezone);
  const firstKey = dayBounds(startKey, timezone).start === from ? startKey : addDays(startKey, 1);
  const firstStart = dayBounds(firstKey, timezone).start;

  // The last whole day that ends at or before the rollup limit.
  const endKey = dayKey(rolledLimit - 1, timezone);
  const lastKey = dayBounds(endKey, timezone).end <= rolledLimit ? endKey : addDays(endKey, -1);
  const lastEnd = dayBounds(lastKey, timezone).end;

  if (firstStart >= lastEnd) {
    return allRaw;
  }

  const days: string[] = [];
  for (let key = firstKey; ; key = addDays(key, 1)) {
    days.push(key);
    if (key === lastKey) {
      break;
    }
  }

  const raw: Range[] = [];
  if (from < firstStart) {
    raw.push({ from, to: firstStart });
  }
  if (lastEnd < to) {
    raw.push({ from: lastEnd, to });
  }
  return { days, raw };
}

// Which rollup row answers a read that has no breakdown dimension: the day's
// totals, or the bot series when the query asked about crawlers.
export function rollupTotalSelector(filters: Filter[] | undefined): { dim: RollupDim; key: string } {
  const hasBotFilter = filters?.some((filter) => filter.dim === BOT_DIMENSION) ?? false;
  if (!hasBotFilter) {
    return { dim: ROLLUP_TOTAL_DIM, key: '' };
  }
  return { dim: BOT_DIMENSION, key: String(botSelector(filters)) };
}
