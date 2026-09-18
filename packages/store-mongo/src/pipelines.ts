import {
  BOT_DIMENSION,
  EVENT_PATH_BY_DIMENSION,
  type Dimension,
  type Filter,
  type Range,
  type RollupDim,
} from '@chokh/store';
import type { Document } from 'mongodb';

// Every read is an aggregation, and every aggregation is built here so the
// explain test can hold the same pipeline the adapter runs.
//
// A unique visitor is a per-day fact, which is why the raw pipelines group by
// day first and only then add the days up: that is the same arithmetic a daily
// rollup does, so a range that crosses the rollup boundary does not change
// meaning halfway through.

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The site, the span and the bot side of the line, plus whatever the query
// filtered on. A bot filter is already answered by the bot field itself, so it
// never becomes a second condition.
export function eventMatch(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document {
  const match: Record<string, unknown> = {
    siteId,
    ts: { $gte: span.from, $lt: span.to },
    bot: wantsBots,
  };
  for (const filter of filters ?? []) {
    if (filter.dim === BOT_DIMENSION) {
      continue;
    }
    const path = EVENT_PATH_BY_DIMENSION[filter.dim];
    if (path === undefined) {
      // A session dimension: AN-SES01 writes it, and nothing raw carries it,
      // so a filter on one can match nothing rather than everything.
      return { siteId, ts: { $lt: 0 } };
    }
    if (filter.op === 'is') {
      match[path] = filter.value;
    } else if (filter.op === 'is_not') {
      match[path] = { $ne: filter.value };
    } else {
      match[path] = { $regex: escapeRegex(filter.value) };
    }
  }
  return match;
}

export function dayExpression(timezone: string): Document {
  return { $dateToString: { date: { $toDate: '$ts' }, format: '%Y-%m-%d', timezone } };
}

export function dimensionExpression(dim: Dimension): Document | string | null {
  if (dim === BOT_DIMENSION) {
    return { $toString: '$bot' };
  }
  const path = EVENT_PATH_BY_DIMENSION[dim];
  return path === undefined ? null : `$${path}`;
}

const IS_PAGEVIEW = { $cond: [{ $eq: ['$type', 'pageview'] }, 1, 0] };

// Totals for a span of raw rows: distinct visitors per day, added up, and
// every pageview in the span.
export function rawTotalsPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  return [
    { $match: eventMatch(siteId, span, wantsBots, filters) },
    {
      $group: {
        _id: { day: dayExpression(timezone), visitorId: '$visitorId' },
        pageviews: { $sum: IS_PAGEVIEW },
      },
    },
    { $group: { _id: '$_id.day', visitors: { $sum: 1 }, pageviews: { $sum: '$pageviews' } } },
    {
      $group: {
        _id: null,
        visitors: { $sum: '$visitors' },
        pageviews: { $sum: '$pageviews' },
      },
    },
  ];
}

// The same, one row per value of a dimension.
export function rawBreakdownPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  const expression = dimensionExpression(dim);
  return [
    { $match: eventMatch(siteId, span, wantsBots, filters) },
    {
      $project: {
        day: dayExpression(timezone),
        visitorId: 1,
        key: { $ifNull: [expression, null] },
        pageview: IS_PAGEVIEW,
      },
    },
    { $match: { key: { $ne: null } } },
    {
      $group: {
        _id: { day: '$day', key: '$key', visitorId: '$visitorId' },
        pageviews: { $sum: '$pageview' },
      },
    },
    {
      $group: {
        _id: { day: '$_id.day', key: '$_id.key' },
        visitors: { $sum: 1 },
        pageviews: { $sum: '$pageviews' },
      },
    },
    {
      $group: {
        _id: '$_id.key',
        visitors: { $sum: '$visitors' },
        pageviews: { $sum: '$pageviews' },
      },
    },
  ];
}

const SUM_TOTALS = {
  visitors: { $sum: '$visitors' },
  pageviews: { $sum: '$pageviews' },
  visits: { $sum: '$visits' },
  bounces: { $sum: '$bounces' },
  durationSum: { $sum: '$durationSum' },
};

export function rollupTotalsPipeline(
  siteId: string,
  days: string[],
  dim: RollupDim,
  key: string,
): Document[] {
  return [
    { $match: { siteId, date: { $in: days }, dim, key } },
    { $group: { _id: null, ...SUM_TOTALS } },
  ];
}

export function rollupBreakdownPipeline(
  siteId: string,
  days: string[],
  dim: Dimension,
): Document[] {
  return [
    { $match: { siteId, date: { $in: days }, dim } },
    { $group: { _id: '$key', ...SUM_TOTALS } },
  ];
}
