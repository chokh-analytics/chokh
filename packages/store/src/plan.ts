import {
  BOT_DIMENSION,
  botSelector,
  needsRawRows,
  type Dimension,
  type Filter,
  type Range,
} from './query.js';
import { addDays, dayBounds, dayKey } from './time.js';

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

export interface ReadPlanOptions {
  from: number;
  to: number;
  todayStart: number;
  timezone: string;
  filters?: Filter[];
  dim?: Dimension;
}

export function readPlan(options: ReadPlanOptions): ReadPlan {
  const { from, to, todayStart, timezone } = options;
  if (to <= from) {
    return { days: [], raw: [] };
  }
  const allRaw: ReadPlan = { days: [], raw: [{ from, to }] };
  if (needsRawRows(options.filters, options.dim)) {
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
