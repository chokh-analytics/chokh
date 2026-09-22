import {
  BOT_DIMENSION,
  EVENT_PATH_BY_DIMENSION,
  EVENT_TYPE_BY_DIMENSION,
  SESSION_PATH_BY_DIMENSION,
  type Dimension,
  type Filter,
  type Interval,
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
  // Conditions on a dimension that belongs to one type of row. They go in an
  // $and rather than beside the fields, so a caller spreading this match and
  // naming a type of its own cannot quietly replace them.
  const typed: Document[] = [];
  for (const filter of filters ?? []) {
    if (filter.dim === BOT_DIMENSION) {
      continue;
    }
    const path = EVENT_PATH_BY_DIMENSION[filter.dim];
    if (path === undefined) {
      // A dimension only a stay carries. assertFilterable refuses those before
      // a read gets this far, because an empty report is a silent wrong
      // number; matching nothing is the belt to that pair of braces.
      return { siteId, ts: { $lt: 0 } };
    }
    const condition =
      filter.op === 'is'
        ? filter.value
        : filter.op === 'is_not'
          ? { $ne: filter.value }
          : { $regex: escapeRegex(filter.value) };
    const type = EVENT_TYPE_BY_DIMENSION[filter.dim];
    if (type === undefined) {
      match[path] = condition;
    } else if (filter.op === 'is_not') {
      // A row of another type has no value here, and "not signup" is true of
      // it, the same answer dimensionValue gives the other adapter.
      typed.push({ $or: [{ type: { $ne: type } }, { [path]: condition }] });
    } else {
      typed.push({ type, [path]: condition });
    }
  }
  if (typed.length > 0) {
    match.$and = typed;
  }
  return match;
}

export function dayExpression(timezone: string, field = '$ts'): Document {
  return { $dateToString: { date: { $toDate: field }, format: '%Y-%m-%d', timezone } };
}

export function dimensionExpression(dim: Dimension): Document | string | null {
  if (dim === BOT_DIMENSION) {
    return { $toString: '$bot' };
  }
  const path = EVENT_PATH_BY_DIMENSION[dim];
  if (path === undefined) {
    return null;
  }
  const type = EVENT_TYPE_BY_DIMENSION[dim];
  return type === undefined ? `$${path}` : { $cond: [{ $eq: ['$type', type] }, `$${path}`, null] };
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

// The session side. A visit belongs to the day the stay began on, so every
// pipeline below cuts by startedAt and never by lastSeenAt: a stay that crosses
// midnight is one visit, on the day it started.

export function sessionMatch(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document {
  const match: Record<string, unknown> = {
    siteId,
    startedAt: { $gte: span.from, $lt: span.to },
    bot: wantsBots,
  };
  for (const filter of filters ?? []) {
    if (filter.dim === BOT_DIMENSION) {
      continue;
    }
    const path = SESSION_PATH_BY_DIMENSION[filter.dim];
    if (path === undefined) {
      // A stay spans pages, screens, languages and events rather than having
      // one of each, so it cannot answer a filter on those. The adapter checks
      // for this before it asks, and this is the belt to that pair of braces.
      return { siteId, startedAt: { $lt: 0 } };
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

export function sessionDimensionExpression(dim: Dimension): Document | string | null {
  if (dim === BOT_DIMENSION) {
    return { $toString: '$bot' };
  }
  const path = SESSION_PATH_BY_DIMENSION[dim];
  return path === undefined ? null : `$${path}`;
}

// One page and away, the same rule isBounce states for the other adapter.
const IS_BOUNCE = { $cond: [{ $lte: ['$pageviews', 1] }, 1, 0] };

const SUM_SESSIONS = {
  visits: { $sum: 1 },
  bounces: { $sum: IS_BOUNCE },
  durationSum: { $sum: '$duration' },
};

// Visits, bounces and time, for a span. Visitors and pageviews are not here:
// those come from events, which is the one place they are counted.
export function sessionTotalsPipeline(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  return [
    { $match: sessionMatch(siteId, span, wantsBots, filters) },
    { $group: { _id: null, ...SUM_SESSIONS } },
  ];
}

// The same, one row per value of a dimension the session row carries.
export function sessionBreakdownPipeline(
  siteId: string,
  span: Range,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  return [
    { $match: sessionMatch(siteId, span, wantsBots, filters) },
    {
      $project: {
        key: { $ifNull: [sessionDimensionExpression(dim), null] },
        pageviews: 1,
        duration: 1,
      },
    },
    { $match: { key: { $ne: null } } },
    { $group: { _id: '$key', ...SUM_SESSIONS } },
  ];
}

// Entry, exit and channel: nothing on an event carries them, so visitors and
// pageviews are counted off the stays as well. Visitors stay a per-day fact,
// the way they are everywhere else.
export function sessionSourcedBreakdownPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  return [
    { $match: sessionMatch(siteId, span, wantsBots, filters) },
    {
      $project: {
        day: dayExpression(timezone, '$startedAt'),
        visitorId: 1,
        key: { $ifNull: [sessionDimensionExpression(dim), null] },
        pageviews: 1,
        duration: 1,
        bounce: IS_BOUNCE,
      },
    },
    { $match: { key: { $ne: null } } },
    {
      $group: {
        _id: { day: '$day', key: '$key', visitorId: '$visitorId' },
        pageviews: { $sum: '$pageviews' },
        visits: { $sum: 1 },
        bounces: { $sum: '$bounce' },
        durationSum: { $sum: '$duration' },
      },
    },
    {
      $group: {
        _id: { day: '$_id.day', key: '$_id.key' },
        visitors: { $sum: 1 },
        pageviews: { $sum: '$pageviews' },
        visits: { $sum: '$visits' },
        bounces: { $sum: '$bounces' },
        durationSum: { $sum: '$durationSum' },
      },
    },
    {
      $group: {
        _id: '$_id.key',
        visitors: { $sum: '$visitors' },
        pageviews: { $sum: '$pageviews' },
        visits: { $sum: '$visits' },
        bounces: { $sum: '$bounces' },
        durationSum: { $sum: '$durationSum' },
      },
    },
  ];
}

// The three pipelines below answer a whole time series in one round trip.
//
// A series used to be one totals query per bucket, which is ninety round trips
// to Atlas for ninety days and about half a second from the droplet. These group
// by day (or by hour) once and hand every bucket back together; the caller folds
// each day into the week or month it belongs to. The numbers are the same by
// construction: visitors over a range of days is already the sum of each day's
// uniques, and the rates are derived from the sums afterwards.
//
// A row comes back under the start instant of its day or hour, so the caller
// never parses a date string or draws a day boundary a second time.
export function bucketKeyExpression(
  timezone: string,
  interval: Interval,
  field = '$ts',
): Document {
  const unit = interval === 'minute' || interval === 'hour' ? interval : 'day';
  return { $dateTrunc: { date: { $toDate: field }, unit, timezone } };
}

// Visitors and pageviews per bucket, from raw events.
export function rawTotalsByBucketPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  interval: Interval,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  return [
    { $match: eventMatch(siteId, span, wantsBots, filters) },
    {
      $group: {
        _id: { bucket: bucketKeyExpression(timezone, interval), visitorId: '$visitorId' },
        pageviews: { $sum: IS_PAGEVIEW },
      },
    },
    { $group: { _id: '$_id.bucket', visitors: { $sum: 1 }, pageviews: { $sum: '$pageviews' } } },
  ];
}

// The same per day, out of the daily rollups, which already hold one row a day.
export function rollupTotalsByDatePipeline(
  siteId: string,
  days: string[],
  dim: RollupDim,
  key: string,
): Document[] {
  return [
    { $match: { siteId, date: { $in: days }, dim, key } },
    { $group: { _id: '$date', ...SUM_TOTALS } },
  ];
}

// Visits, bounces and time per bucket. A visit belongs to the bucket its stay
// began in, which is why this truncates startedAt and not ts.
export function sessionTotalsByBucketPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  interval: Interval,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  return [
    { $match: sessionMatch(siteId, span, wantsBots, filters) },
    { $group: { _id: bucketKeyExpression(timezone, interval, '$startedAt'), ...SUM_SESSIONS } },
  ];
}

// Time on page and scroll depth per value of one dimension, from the leave
// beacons of a span.
//
// The type match is inside the same $match as the site and the range, so the
// {siteId, ts} index still leads the plan and the leaves are filtered as the
// index is walked rather than afterwards. The two counts are separate sums
// because a leave can carry a duration, a depth, both or neither, and a
// missing one must not be averaged in as a zero.
export function engagementPipeline(
  siteId: string,
  span: Range,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  const key = dimensionExpression(dim);
  return [
    { $match: { ...eventMatch(siteId, span, wantsBots, filters), type: 'leave' } },
    {
      $group: {
        _id: key,
        durationSum: { $sum: { $ifNull: ['$duration', 0] } },
        durationCount: { $sum: { $cond: [{ $ne: ['$duration', null] }, 1, 0] } },
        scrollSum: { $sum: { $ifNull: ['$scrollDepth', 0] } },
        scrollCount: { $sum: { $cond: [{ $ne: ['$scrollDepth', null] }, 1, 0] } },
        leaves: { $sum: 1 },
      },
    },
  ];
}
