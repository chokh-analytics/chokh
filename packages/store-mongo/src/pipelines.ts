import {
  BOT_DIMENSION,
  EVENT_PATH_BY_DIMENSION,
  EVENT_TYPE_BY_DIMENSION,
  SESSION_PATH_BY_DIMENSION,
  JOURNEY_ROWS_PER_VISIT,
  JOURNEY_STEPS,
  MAX_FUNNEL_ROWS_PER_VISITOR,
  MAX_PROPERTY_KEYS,
  goalIsPattern,
  goalPattern,
  routePattern,
  splitVisitFilters,
  type Dimension,
  type Filter,
  type FunnelRead,
  type Goal,
  type GoalMatch,
  type Interval,
  type Range,
  type RollupDim,
} from '@chokh/store';
import type { Document } from 'mongodb';

import { EVENTS, SESSIONS } from './schema.js';

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

// One filter as a match condition on the field its dimension lives at.
function filterCondition(filter: Filter): unknown {
  return filter.op === 'is'
    ? filter.value
    : filter.op === 'is_not'
      ? { $ne: filter.value }
      : { $regex: escapeRegex(filter.value) };
}

// The site, the span and the bot side of the line, plus whatever the query
// filtered on that a row carries. A bot filter is already answered by the bot
// field itself, so it never becomes a second condition. A filter only a stay
// carries is not here either: stayJoinStages answers it by the row's stay, and
// the one thing this match does for it is keep the rows that have a stay at
// all, so a row written before stays were stamped never reaches the join and
// is out of the report, the rule funnelPipeline already applies.
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
  // Every condition goes in an $and rather than beside the fields. Two filters
  // on one dimension (page is not /a, page is not /b) written beside the
  // fields would overwrite each other and answer only the last, which the
  // other adapter never did; and a caller spreading this match and naming a
  // type of its own cannot quietly replace a typed condition.
  const conditions: Document[] = [];
  const split = splitVisitFilters(filters);
  for (const filter of split.event) {
    const path = EVENT_PATH_BY_DIMENSION[filter.dim];
    if (path === undefined) {
      // Not reachable: every dimension a row carries is on this side of the
      // split. Matching nothing is the belt to that pair of braces.
      return { siteId, ts: { $lt: 0 } };
    }
    const condition = filterCondition(filter);
    const type = EVENT_TYPE_BY_DIMENSION[filter.dim];
    if (type === undefined) {
      conditions.push({ [path]: condition });
    } else if (filter.op === 'is_not') {
      // A row of another type has no value here, and "not signup" is true of
      // it, the same answer dimensionValue gives the other adapter.
      conditions.push({ $or: [{ type: { $ne: type } }, { [path]: condition }] });
    } else {
      conditions.push({ type, [path]: condition });
    }
  }
  if (split.stay.length > 0) {
    match.sessionId = { $type: 'string' };
  }
  if (conditions.length > 0) {
    match.$and = conditions;
  }
  return match;
}

// The stay a row belongs to, when a filter names something only a stay
// carries: one lookup per row on the stay's identity index with the stay
// conditions inside it, and the rows whose stay did not match dropped. There
// is no window on the stay, on purpose: a row at ten past midnight belongs to
// the stay that began before it, whichever day that was, the same answer the
// other adapter's set of stay ids gives.
export function stayJoinStages(siteId: string, filters: Filter[] | undefined): Document[] {
  const { stay } = splitVisitFilters(filters);
  if (stay.length === 0) {
    return [];
  }
  const conditions: Document[] = [];
  for (const filter of stay) {
    const path = SESSION_PATH_BY_DIMENSION[filter.dim];
    if (path !== undefined) {
      conditions.push({ [path]: filterCondition(filter) });
    }
  }
  return [
    {
      $lookup: {
        from: SESSIONS,
        let: { sessionId: '$sessionId' },
        pipeline: [
          { $match: { siteId, $expr: { $eq: ['$id', '$$sessionId'] }, $and: conditions } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'stay',
      },
    },
    { $match: { stay: { $ne: [] } } },
  ];
}

// What every pipeline over rows opens with: the match, then the join when a
// filter needs one. extra rides in the same $match as the site and the range,
// so the {siteId, ts} index still leads and a type is filtered as the index is
// walked rather than afterwards.
export function eventStages(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  extra: Document = {},
): Document[] {
  return [
    { $match: { ...eventMatch(siteId, span, wantsBots, filters), ...extra } },
    ...stayJoinStages(siteId, filters),
  ];
}

// The route of a row from a site's rules, as regroupRoutes runs it over every
// stored row in one pipeline update: the first rule the path matches, else
// the path itself, and no route at all on a row with no path. The same
// patterns routeOf compiles for the other adapter.
export function routeExpression(rules: readonly string[]): Document {
  const grouped: Document | string =
    rules.length === 0
      ? '$path'
      : {
          $switch: {
            branches: rules.map((rule) => ({
              case: { $regexMatch: { input: '$path', regex: routePattern(rule) } },
              then: rule,
            })),
            default: '$path',
          },
        };
  return { $cond: [{ $eq: [{ $type: '$path' }, 'string'] }, grouped, '$$REMOVE'] };
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
    ...eventStages(siteId, span, wantsBots, filters),
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
    ...eventStages(siteId, span, wantsBots, filters),
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
  // In an $and, for the same reason eventMatch keeps its conditions there: two
  // filters on one dimension must both apply.
  const conditions: Document[] = [];
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
    conditions.push({ [path]: filterCondition(filter) });
  }
  if (conditions.length > 0) {
    match.$and = conditions;
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
    ...eventStages(siteId, span, wantsBots, filters),
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
    ...eventStages(siteId, span, wantsBots, filters, { type: 'leave' }),
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

// Conversions. A conversion is an overlap of two sets of people per day, the
// people a read counted and the people who reached the goal, so each pipeline
// below is one round trip that gathers both halves under the same
// {day, visitorId} key: the counted half from the collection that counts that
// read's visitors, and the goal half pulled in from events by $unionWith. Both
// halves open with a $match on the site and the range, so both lead with an
// index.

// The rows that reach a goal. The site, the span, the bot side and the goal,
// and none of the query's other filters: those narrow the people a conversion
// is counted against, never the goal. The same rule conversionMatcher states
// for the other adapter.
export function goalMatch(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  goal: GoalMatch,
): Document {
  const base = { siteId, ts: { $gte: span.from, $lt: span.to }, bot: wantsBots };
  if (goal.kind === 'event') {
    return { ...base, type: 'event', name: goal.match };
  }
  return {
    ...base,
    type: 'pageview',
    path: goalIsPattern(goal) ? { $regex: goalPattern(goal.match) } : goal.match,
  };
}

// Per day and visitor, how many times the goal was reached.
export function convertersPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  goal: GoalMatch,
): Document[] {
  return [
    { $match: goalMatch(siteId, span, wantsBots, goal) },
    {
      $group: {
        _id: { day: dayExpression(timezone), visitorId: '$visitorId' },
        completions: { $sum: 1 },
      },
    },
  ];
}

// Converted visitors and completions for a whole read, against the people its
// own events counted.
export function conversionTotalsPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  goal: GoalMatch,
): Document[] {
  return [
    ...eventStages(siteId, span, wantsBots, filters),
    { $group: { _id: { day: dayExpression(timezone), visitorId: '$visitorId' }, counted: { $max: 1 } } },
    {
      $unionWith: {
        coll: EVENTS,
        pipeline: convertersPipeline(siteId, span, timezone, wantsBots, goal),
      },
    },
    {
      $group: {
        _id: '$_id',
        counted: { $max: '$counted' },
        completions: { $sum: '$completions' },
      },
    },
    { $match: { counted: 1, completions: { $gt: 0 } } },
    { $group: { _id: null, visitors: { $sum: 1 }, completions: { $sum: '$completions' } } },
  ];
}

// The half of a breakdown's conversion read that is the same for both kinds of
// membership: bring the goal in, keep the visitor-days that reached it, and
// count them once for every value they were counted under.
function conversionTail(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  goal: GoalMatch,
): Document[] {
  return [
    {
      $unionWith: {
        coll: EVENTS,
        pipeline: convertersPipeline(siteId, span, timezone, wantsBots, goal),
      },
    },
    {
      $group: {
        _id: '$_id',
        keys: { $push: { $ifNull: ['$keys', []] } },
        completions: { $sum: '$completions' },
      },
    },
    { $match: { completions: { $gt: 0 } } },
    {
      $project: {
        completions: 1,
        keys: { $reduce: { input: '$keys', initialValue: [], in: { $setUnion: ['$$value', '$$this'] } } },
      },
    },
    { $unwind: '$keys' },
    { $group: { _id: '$keys', visitors: { $sum: 1 }, completions: { $sum: '$completions' } } },
  ];
}

// Converted visitors per value of a dimension an event carries, counted
// against the events that put each visitor in each row.
export function conversionBreakdownPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  goal: GoalMatch,
): Document[] {
  return [
    ...eventStages(siteId, span, wantsBots, filters),
    {
      $project: {
        day: dayExpression(timezone),
        visitorId: 1,
        key: { $ifNull: [dimensionExpression(dim), null] },
      },
    },
    { $match: { key: { $ne: null } } },
    { $group: { _id: { day: '$day', visitorId: '$visitorId' }, keys: { $addToSet: '$key' } } },
    ...conversionTail(siteId, span, timezone, wantsBots, goal),
  ];
}

// The same for entry, exit and channel, whose visitors are counted off the
// stays: a visitor is in a row on the day a stay of theirs with that value
// began, the rule the breakdown already counts them by.
export function sessionConversionBreakdownPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  goal: GoalMatch,
): Document[] {
  return [
    { $match: sessionMatch(siteId, span, wantsBots, filters) },
    {
      $project: {
        day: dayExpression(timezone, '$startedAt'),
        visitorId: 1,
        key: { $ifNull: [sessionDimensionExpression(dim), null] },
      },
    },
    { $match: { key: { $ne: null } } },
    { $group: { _id: { day: '$day', visitorId: '$visitorId' }, keys: { $addToSet: '$key' } } },
    ...conversionTail(siteId, span, timezone, wantsBots, goal),
  ];
}

// The events report and the property breakdown. Custom events only, by type,
// so a page timing never reaches either.

function customEventStages(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  name?: string,
): Document[] {
  return eventStages(siteId, span, wantsBots, filters, {
    type: 'event',
    name: name ?? { $exists: true },
  });
}

// Visitors, each day's added up, and how many times, per event name.
export function eventsPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Document[] {
  return [
    ...customEventStages(siteId, span, wantsBots, filters),
    {
      $group: {
        _id: { day: dayExpression(timezone), key: '$name', visitorId: '$visitorId' },
        events: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: { day: '$_id.day', key: '$_id.key' },
        visitors: { $sum: 1 },
        events: { $sum: '$events' },
      },
    },
    { $group: { _id: '$_id.key', visitors: { $sum: '$visitors' }, events: { $sum: '$events' } } },
  ];
}

// The property names one event carried, most used first.
export function propertyKeysPipeline(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  event: string,
): Document[] {
  return [
    ...customEventStages(siteId, span, wantsBots, filters, event),
    { $project: { pair: { $objectToArray: { $ifNull: ['$props', {}] } } } },
    { $unwind: '$pair' },
    { $group: { _id: '$pair.k', events: { $sum: 1 } } },
    { $sort: { events: -1, _id: 1 } },
    { $limit: MAX_PROPERTY_KEYS },
  ];
}

// One event broken down by one property. The value is read with $getField and
// a literal name, never as a props.<name> path: a property is whatever a page
// passed, and a name with a dot in it would otherwise become a nested path, and
// one starting with a dollar an operator. $getField is MongoDB 5.0 and later,
// which is why the adapter reads the server's version when it opens.
export function propertyValuesPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  event: string,
  property: string,
): Document[] {
  return [
    ...customEventStages(siteId, span, wantsBots, filters, event),
    {
      $project: {
        day: dayExpression(timezone),
        visitorId: 1,
        key: {
          $ifNull: [
            { $getField: { field: { $literal: property }, input: { $ifNull: ['$props', {}] } } },
            '',
          ],
        },
      },
    },
    {
      $group: {
        _id: { day: '$day', key: '$key', visitorId: '$visitorId' },
        events: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: { day: '$_id.day', key: '$_id.key' },
        visitors: { $sum: 1 },
        events: { $sum: '$events' },
      },
    },
    { $group: { _id: '$_id.key', visitors: { $sum: '$visitors' }, events: { $sum: '$events' } } },
  ];
}

// Whether a row reaches a goal, as an expression rather than a query, so one
// pass can tag each row with every goal it reaches: a pattern goal and an
// exact goal can both be reached by the same pageview.
function goalExpression(goal: GoalMatch): Document {
  if (goal.kind === 'event') {
    return { $and: [{ $eq: ['$type', 'event'] }, { $eq: ['$name', goal.match] }] };
  }
  if (!goalIsPattern(goal)) {
    return { $and: [{ $eq: ['$type', 'pageview'] }, { $eq: ['$path', goal.match] }] };
  }
  return {
    $and: [
      { $eq: ['$type', 'pageview'] },
      { $regexMatch: { input: { $ifNull: ['$path', ''] }, regex: goalPattern(goal.match) } },
    ],
  };
}

// The same question as a query, for the $match that narrows the rows first.
function goalCondition(goal: GoalMatch): Document {
  if (goal.kind === 'event') {
    return { type: 'event', name: goal.match };
  }
  return {
    type: 'pageview',
    path: goalIsPattern(goal) ? { $regex: goalPattern(goal.match) } : goal.match,
  };
}

// Every goal's converted visitors and completions in one round trip, against
// the people the read's own events counted.
export function goalStatsPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  goals: Goal[],
): Document[] {
  const day = dayExpression(timezone);
  return [
    ...eventStages(siteId, span, wantsBots, filters),
    { $group: { _id: { day, visitorId: '$visitorId' }, counted: { $max: 1 } } },
    {
      $unionWith: {
        coll: EVENTS,
        pipeline: [
          {
            $match: {
              siteId,
              ts: { $gte: span.from, $lt: span.to },
              bot: wantsBots,
              $or: goals.map(goalCondition),
            },
          },
          {
            $project: {
              day,
              visitorId: 1,
              goals: {
                $setDifference: [
                  goals.map((goal) => ({ $cond: [goalExpression(goal), goal.id, null] })),
                  [null],
                ],
              },
            },
          },
          { $unwind: '$goals' },
          {
            $group: {
              _id: { day: '$day', visitorId: '$visitorId', goal: '$goals' },
              completions: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: { day: '$_id.day', visitorId: '$_id.visitorId' },
              goal: '$_id.goal',
              completions: 1,
            },
          },
        ],
      },
    },
    {
      $group: {
        _id: '$_id',
        counted: { $max: '$counted' },
        reached: { $push: { goal: '$goal', completions: '$completions' } },
      },
    },
    { $match: { counted: 1 } },
    { $unwind: '$reached' },
    { $match: { 'reached.goal': { $type: 'string' } } },
    {
      $group: {
        _id: '$reached.goal',
        visitors: { $sum: 1 },
        completions: { $sum: '$reached.completions' },
      },
    },
  ];
}

// The funnel read. One aggregation on events, in the shape a goal read has: one
// half says who is in the segment, a $unionWith brings in how far each of them
// got, and the two meet per visitor. Only the step rows are sorted, and at most
// steps + 1 documents come back whatever the traffic.

// The fold of funnel.ts as a $reduce over a visitor's step rows in funnel
// order. It keeps the latest start of a chain at every step and updates every
// step from the state before the row, so it is funnelDepth line for line, and
// the funnel test in this package runs the seeded sequences funnelDepth is
// proved on through these stages and compares.
function funnelFoldExpression(stepCount: number, windowMs: number): Document {
  const initial: null[] = new Array<null>(stepCount).fill(null);
  // One expression per step, written out rather than a $map over $range: the
  // step count is known when the pipeline is built, and an index that is a
  // constant costs nothing per row, where a $map pays for the range, the
  // comparison and the subtraction on every one of them.
  const next: Document[] = [];
  for (let step = 0; step < stepCount; step += 1) {
    if (step === 0) {
      next.push({
        $cond: [{ $arrayElemAt: ['$$this.h', 0] }, '$$this.t', { $arrayElemAt: ['$$value', 0] }],
      });
      continue;
    }
    next.push({
      $let: {
        vars: {
          start: { $arrayElemAt: ['$$value', step - 1] },
          current: { $arrayElemAt: ['$$value', step] },
        },
        in: {
          $cond: [
            {
              $and: [
                { $arrayElemAt: ['$$this.h', step] },
                { $ne: ['$$start', null] },
                { $lte: [{ $subtract: ['$$this.t', '$$start'] }, windowMs] },
              ],
            },
            // $max passes over a null, so an empty step takes the start.
            { $max: ['$$current', '$$start'] },
            '$$current',
          ],
        },
      },
    });
  }
  const best = { $reduce: { input: '$rows', initialValue: initial, in: next } };
  return { $size: { $filter: { input: best, cond: { $ne: ['$$this', null] } } } };
}

// From step rows ({visitorId, sessionId, ts, hits, first, mask}) to one
// {_id: visitorId, depth} each. Exported on its own so the equality test can
// run exactly these stages over the seeded sequences.
//
// The $sort is the read's one blocking sort, and it sorts step rows only. It
// is also what orders each visitor's $push: $setWindowFields partitions by the
// same keys the rows are already sorted by, the cap keeps the first thousand
// in that order, and $group pushes in the order it receives.
export function funnelFoldStages(stepCount: number, windowMs: number, byVisit: boolean): Document[] {
  const stages: Document[] = [
    { $sort: { visitorId: 1, ts: 1, first: 1, mask: 1 } },
    {
      $setWindowFields: {
        partitionBy: '$visitorId',
        sortBy: { ts: 1, first: 1, mask: 1 },
        // A running count rather than $documentNumber, which takes one sort key
        // and not the three that make equal times an order.
        output: { n: { $sum: 1, window: { documents: ['unbounded', 'current'] } } },
      },
    },
    { $match: { n: { $lte: MAX_FUNNEL_ROWS_PER_VISITOR } } },
    {
      $group: {
        _id: byVisit ? { visitorId: '$visitorId', sessionId: '$sessionId' } : '$visitorId',
        rows: { $push: { t: '$ts', h: '$hits' } },
      },
    },
    { $project: { depth: funnelFoldExpression(stepCount, windowMs) } },
  ];
  if (byVisit) {
    stages.push({ $group: { _id: '$_id.visitorId', depth: { $max: '$depth' } } });
  }
  return stages;
}

// Every row that reaches at least one step, tagged with which, and with the two
// numbers funnel.ts orders equal times by: the lowest step reached, and every
// step reached as one number.
function funnelStepRows(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  funnel: FunnelRead,
): Document[] {
  const conditions: Document[] = [];
  for (const step of funnel.steps) {
    const condition = goalCondition(step);
    if (!conditions.some((seen) => JSON.stringify(seen) === JSON.stringify(condition))) {
      conditions.push(condition);
    }
  }
  const match: Document = {
    siteId,
    ts: { $gte: span.from, $lt: span.to },
    bot: wantsBots,
    $or: conditions,
  };
  if (funnel.window === 'visit') {
    // A row written before stays were stamped has no visit to be in.
    match.sessionId = { $type: 'string' };
  }
  return [
    { $match: match },
    {
      $project: {
        _id: 0,
        visitorId: 1,
        sessionId: 1,
        ts: 1,
        hits: funnel.steps.map((step) => goalExpression(step)),
      },
    },
    {
      $addFields: {
        first: {
          $let: {
            vars: { at: { $indexOfArray: ['$hits', true] } },
            in: { $cond: [{ $eq: ['$$at', -1] }, funnel.steps.length, '$$at'] },
          },
        },
        mask: {
          $sum: funnel.steps.map((_, index) => ({
            $cond: [{ $arrayElemAt: ['$hits', index] }, 2 ** index, 0],
          })),
        },
      },
    },
  ];
}

export function funnelPipeline(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: { event: Filter[]; stay: Filter[] },
  funnel: FunnelRead,
  windowMs: number,
): Document[] {
  const stay = filters.stay.length > 0;
  return [
    // The segment by its rows.
    { $match: eventMatch(siteId, span, wantsBots, filters.event) },
    { $group: { _id: '$visitorId', member: { $max: 1 } } },
    // And by its stays, when a filter names something only a stay carries.
    ...(stay
      ? [
          {
            $unionWith: {
              coll: SESSIONS,
              pipeline: [
                { $match: sessionMatch(siteId, span, wantsBots, filters.stay) },
                { $group: { _id: '$visitorId', stay: { $max: 1 } } },
              ],
            },
          },
        ]
      : []),
    // How far everybody got; the segment decides whose depth counts.
    {
      $unionWith: {
        coll: EVENTS,
        pipeline: [
          ...funnelStepRows(siteId, span, wantsBots, funnel),
          ...funnelFoldStages(funnel.steps.length, windowMs, funnel.window === 'visit'),
        ],
      },
    },
    {
      $group: {
        _id: '$_id',
        member: { $max: '$member' },
        stay: { $max: '$stay' },
        depth: { $max: '$depth' },
      },
    },
    { $match: stay ? { member: 1, stay: 1 } : { member: 1 } },
    { $group: { _id: { $ifNull: ['$depth', 0] }, visitors: { $sum: 1 } } },
  ];
}

// The journeys read, in two round trips over the same visits. A column's most
// visited pages have to be known before its links can be folded onto them, and
// the one trip alternative, sending every distinct four page path back, grows
// with the site. So the first trip answers each column's top pages and the
// second answers the folded counts, and both answer at most a few hundred
// documents whatever the traffic.

// Every visit that began in the range and viewed a page, as {steps, onward}:
// its first JOURNEY_ROWS_PER_VISIT pageviews in time order, a page repeated
// back to back counted once, cut to JOURNEY_STEPS. It starts on sessions,
// because a visit is in the report by its stay; a row filter comes in through
// a $unionWith, and so do the pageviews, where the one blocking sort is.
function journeyVisitStages(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: { event: Filter[]; stay: Filter[] },
): Document[] {
  const byRow = filters.event.length > 0;
  return [
    { $match: sessionMatch(siteId, span, wantsBots, filters.stay) },
    { $project: { _id: 0, sessionId: '$id', visit: { $literal: 1 } } },
    ...(byRow
      ? [
          {
            $unionWith: {
              coll: EVENTS,
              pipeline: [
                { $match: eventMatch(siteId, span, wantsBots, filters.event) },
                { $group: { _id: '$sessionId' } },
                { $project: { _id: 0, sessionId: '$_id', matched: { $literal: 1 } } },
              ],
            },
          },
        ]
      : []),
    {
      $unionWith: {
        coll: EVENTS,
        pipeline: [
          {
            $match: {
              siteId,
              ts: { $gte: span.from, $lt: span.to },
              bot: wantsBots,
              type: 'pageview',
              sessionId: { $type: 'string' },
            },
          },
          { $project: { _id: 0, sessionId: 1, ts: 1, path: { $ifNull: ['$path', ''] } } },
          { $sort: { sessionId: 1, ts: 1, path: 1 } },
          {
            $setWindowFields: {
              partitionBy: '$sessionId',
              sortBy: { ts: 1, path: 1 },
              output: { n: { $sum: 1, window: { documents: ['unbounded', 'current'] } } },
            },
          },
          { $match: { n: { $lte: JOURNEY_ROWS_PER_VISIT } } },
          { $group: { _id: '$sessionId', paths: { $push: '$path' } } },
          { $project: { _id: 0, sessionId: '$_id', paths: 1 } },
        ],
      },
    },
    {
      $group: {
        _id: '$sessionId',
        visit: { $max: '$visit' },
        matched: { $max: '$matched' },
        paths: { $max: '$paths' },
      },
    },
    {
      $match: {
        visit: 1,
        paths: { $type: 'array' },
        ...(byRow ? { matched: 1 } : {}),
      },
    },
    {
      $project: {
        collapsed: {
          $reduce: {
            input: '$paths',
            initialValue: [],
            in: {
              $cond: [
                { $eq: [{ $arrayElemAt: ['$$value', -1] }, '$$this'] },
                '$$value',
                { $concatArrays: ['$$value', ['$$this']] },
              ],
            },
          },
        },
      },
    },
    {
      $project: {
        steps: { $slice: ['$collapsed', JOURNEY_STEPS] },
        onward: { $gt: [{ $size: '$collapsed' }, JOURNEY_STEPS] },
      },
    },
  ];
}

// The first trip: each column's most visited pages, most first, ties by path.
export function journeyTopPipeline(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: { event: Filter[]; stay: Filter[] },
  branches: number,
): Document[] {
  const facets: Record<string, Document[]> = {};
  for (let column = 0; column < JOURNEY_STEPS; column += 1) {
    facets[`c${column}`] = [
      { $match: { [`steps.${column}`]: { $exists: true } } },
      { $group: { _id: { $arrayElemAt: ['$steps', column] }, visits: { $sum: 1 } } },
      { $sort: { visits: -1, _id: 1 } },
      { $limit: branches },
    ];
  }
  return [...journeyVisitStages(siteId, span, wantsBots, filters), { $facet: facets }];
}

// The second trip: every visit folded onto the first trip's pages and counted
// per column, the rows journeyStepCounts answers in memory.
export function journeyStepsPipeline(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: { event: Filter[]; stay: Filter[] },
  tops: readonly (readonly string[])[],
): Document[] {
  const last = JOURNEY_STEPS - 1;
  return [
    ...journeyVisitStages(siteId, span, wantsBots, filters),
    {
      $project: {
        onward: 1,
        size: { $size: '$steps' },
        keys: {
          $map: {
            input: { $range: [0, { $size: '$steps' }] },
            as: 'column',
            in: {
              $let: {
                vars: { page: { $arrayElemAt: ['$steps', '$$column'] } },
                in: {
                  $cond: [
                    // A literal, so a path is never read as a field or an operator.
                    { $in: ['$$page', { $arrayElemAt: [{ $literal: tops }, '$$column'] }] },
                    '$$page',
                    null,
                  ],
                },
              },
            },
          },
        },
      },
    },
    {
      $project: {
        counts: {
          $map: {
            input: { $range: [0, '$size'] },
            as: 'column',
            in: {
              $let: {
                vars: { next: { $add: ['$$column', 1] } },
                in: {
                  column: '$$column',
                  from: { $arrayElemAt: ['$keys', '$$column'] },
                  to: {
                    $cond: [{ $lt: ['$$next', '$size'] }, { $arrayElemAt: ['$keys', '$$next'] }, null],
                  },
                  end: {
                    $cond: [
                      { $lt: ['$$next', '$size'] },
                      'next',
                      {
                        $cond: [
                          { $and: [{ $eq: ['$$column', last] }, '$onward'] },
                          'onward',
                          'exit',
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    { $unwind: '$counts' },
    { $group: { _id: '$counts', visits: { $sum: 1 } } },
  ];
}
