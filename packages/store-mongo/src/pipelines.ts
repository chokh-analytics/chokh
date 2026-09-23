import {
  BOT_DIMENSION,
  EVENT_PATH_BY_DIMENSION,
  EVENT_TYPE_BY_DIMENSION,
  SESSION_PATH_BY_DIMENSION,
  MAX_FUNNEL_ROWS_PER_VISITOR,
  MAX_PROPERTY_KEYS,
  goalIsPattern,
  goalPattern,
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
    { $match: eventMatch(siteId, span, wantsBots, filters) },
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
    { $match: eventMatch(siteId, span, wantsBots, filters) },
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

function customEventMatch(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  name?: string,
): Document {
  return {
    ...eventMatch(siteId, span, wantsBots, filters),
    type: 'event',
    name: name ?? { $exists: true },
  };
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
    { $match: customEventMatch(siteId, span, wantsBots, filters) },
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
    { $match: customEventMatch(siteId, span, wantsBots, filters, event) },
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
    { $match: customEventMatch(siteId, span, wantsBots, filters, event) },
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
    { $match: eventMatch(siteId, span, wantsBots, filters) },
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
  const best = {
    $reduce: {
      input: '$rows',
      initialValue: initial,
      in: {
        $map: {
          input: { $range: [0, stepCount] },
          // Named, so $$this is still the row the $reduce is on.
          as: 'step',
          in: {
            $cond: [
              { $eq: ['$$step', 0] },
              {
                $cond: [
                  { $arrayElemAt: ['$$this.h', 0] },
                  '$$this.t',
                  { $arrayElemAt: ['$$value', 0] },
                ],
              },
              {
                $let: {
                  vars: {
                    start: { $arrayElemAt: ['$$value', { $subtract: ['$$step', 1] }] },
                    current: { $arrayElemAt: ['$$value', '$$step'] },
                  },
                  in: {
                    $cond: [
                      {
                        $and: [
                          { $arrayElemAt: ['$$this.h', '$$step'] },
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
              },
            ],
          },
        },
      },
    },
  };
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
