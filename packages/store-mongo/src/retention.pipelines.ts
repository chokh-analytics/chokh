import type { CohortInterval, GoalMatch, Range } from '@chokh/store';
import type { Document } from 'mongodb';

import { goalMatch } from './pipelines.js';
import { VISITORS } from './schema.js';

// Retention (AN-PPL01). Every read below starts with one walk of
// session_site_started (or, for attribution, of event_site_ts on the goal's own
// rows) and folds inside the pipeline, so what crosses the wire is a grid, a
// few hundred deltas, one page of people or one row per converter, and never a
// row per visitor.
// retention.ts in @chokh/store holds the same rules in JS for the in-memory
// adapter; the conformance suite holds the two to one answer.

function humanStaysIn(siteId: string, span: Range): Document {
  return { siteId, startedAt: { $gte: span.from, $lt: span.to }, bot: false };
}

// (cohort start, bucket start, visitors): per visitor, the buckets they began a
// stay in and the earliest bucket of a stay marked new, then counted per pair.
// At most one row per cell of the grid.
export function cohortPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  interval: CohortInterval,
): Document[] {
  const truncate = {
    $dateTrunc: {
      date: { $toDate: '$startedAt' },
      unit: interval,
      timezone,
      ...(interval === 'week' ? { startOfWeek: 'monday' } : {}),
    },
  };
  return [
    { $match: humanStaysIn(siteId, span) },
    { $group: { _id: { v: '$visitorId', b: truncate }, n: { $max: '$isNew' } } },
    {
      $group: {
        _id: '$_id.v',
        buckets: { $push: '$_id.b' },
        // $min passes over the nulls, so this is the first new bucket or null.
        cohort: { $min: { $cond: [{ $eq: ['$n', true] }, '$_id.b', null] } },
      },
    },
    { $match: { cohort: { $ne: null } } },
    { $unwind: '$buckets' },
    { $match: { $expr: { $gte: ['$buckets', '$cohort'] } } },
    { $group: { _id: { c: '$cohort', b: '$buckets' }, visitors: { $sum: 1 } } },
  ];
}

// From a span's stays to one {_id: visitorId, days, first} per visitor: the span
// days (counted in the site's calendar from the span's first midnight) they
// began a stay on, ascending and without repeats, and the day of their first
// stay or null. The $sort is what orders each $push; it sorts (visitor, day)
// pairs, which are at most the stays.
export function activityDayStages(siteId: string, span: Range, timezone: string): Document[] {
  const day = {
    $dateDiff: {
      startDate: new Date(span.from),
      endDate: { $toDate: '$startedAt' },
      unit: 'day',
      timezone,
    },
  };
  return [
    { $match: humanStaysIn(siteId, span) },
    { $group: { _id: { v: '$visitorId', d: day }, n: { $max: '$isNew' } } },
    { $sort: { '_id.v': 1, '_id.d': 1 } },
    {
      $group: {
        _id: '$_id.v',
        days: { $push: '$_id.d' },
        first: { $min: { $cond: [{ $eq: ['$n', true] }, '$_id.d', null] } },
      },
    },
  ];
}

// windowIntervals of retention.ts as a $reduce: each run of active days merged
// into [s, e], the days a window of `width` days ending on one of them covers,
// and each run written as +1 at s and -1 at e + 1.
function windowDeltas(width: number): Document {
  const merged = {
    $reduce: {
      input: '$days',
      initialValue: { o: [], s: -1, e: -2 },
      in: {
        $cond: [
          { $lte: ['$$this', { $add: ['$$value.e', 1] }] },
          {
            o: '$$value.o',
            s: '$$value.s',
            e: { $max: ['$$value.e', { $add: ['$$this', width - 1] }] },
          },
          {
            o: {
              $cond: [
                { $gte: ['$$value.s', 0] },
                {
                  $concatArrays: [
                    '$$value.o',
                    [
                      { k: width, d: '$$value.s', n: 1 },
                      { k: width, d: { $add: ['$$value.e', 1] }, n: -1 },
                    ],
                  ],
                },
                '$$value.o',
              ],
            },
            s: '$$this',
            e: { $add: ['$$this', width - 1] },
          },
        ],
      },
    },
  };
  return {
    $let: {
      vars: { m: merged },
      in: {
        $concatArrays: [
          '$$m.o',
          [
            { k: width, d: '$$m.s', n: 1 },
            { k: width, d: { $add: ['$$m.e', 1] }, n: -1 },
          ],
        ],
      },
    },
  };
}

// From one {days, first} per visitor to deltas summed per (kind, day): kinds 1,
// 7 and 30 are the windows' +1/-1 per span day, 'c' counts visitors by how many
// days of the range they were active on, 'r' counts the returning ones.
// Exported on its own so the equality test can run exactly these stages over
// seeded visitors and compare them with addVisitorDays.
export function activityFoldStages(offset: number, windows: readonly number[]): Document[] {
  const active = {
    $size: { $filter: { input: '$days', cond: { $gte: ['$$this', offset] } } },
  };
  return [
    {
      $project: {
        _id: 0,
        x: {
          $let: {
            vars: { active },
            in: {
              $concatArrays: [
                ...windows.map(windowDeltas),
                { $cond: [{ $gt: ['$$active', 0] }, [{ k: 'c', d: '$$active', n: 1 }], []] },
                {
                  $cond: [
                    {
                      $and: [
                        { $gt: ['$$active', 0] },
                        {
                          $or: [
                            { $eq: [{ $ifNull: ['$first', null] }, null] },
                            { $gt: [{ $last: '$days' }, '$first'] },
                          ],
                        },
                      ],
                    },
                    [{ k: 'r', d: 0, n: 1 }],
                    [],
                  ],
                },
              ],
            },
          },
        },
      },
    },
    { $unwind: '$x' },
    { $group: { _id: { k: '$x.k', d: '$x.d' }, n: { $sum: '$x.n' } } },
  ];
}

// The most active people of a range: active days and visits per visitor, the top
// `limit` in the order comparePowerUsers keeps, then each one's visitor row by
// its unique key. The $sort is a top-k sort over the per-visitor rows, and the
// $lookup runs once per row that survives the $limit.
export function powerUsersPipeline(
  siteId: string,
  span: Range,
  timezone: string,
  minDays: number,
  limit: number,
): Document[] {
  return [
    { $match: humanStaysIn(siteId, span) },
    {
      $group: {
        _id: {
          v: '$visitorId',
          d: { $dateTrunc: { date: { $toDate: '$startedAt' }, unit: 'day', timezone } },
        },
        visits: { $sum: 1 },
      },
    },
    { $group: { _id: '$_id.v', activeDays: { $sum: 1 }, visits: { $sum: '$visits' } } },
    { $match: { activeDays: { $gte: minDays } } },
    { $sort: { activeDays: -1, visits: -1, _id: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: VISITORS,
        localField: '_id',
        foreignField: 'id',
        pipeline: [
          { $match: { siteId } },
          { $project: { _id: 0, expiresAt: 0, places: 0, firstTouch: 0, lastTouch: 0 } },
        ],
        as: 'visitor',
      },
    },
    { $unwind: '$visitor' },
  ];
}

// Who converted: the goal's rows of the range (the match a goal read walks
// event_site_ts with), sorted so each visitor's first conversion leads, and one
// {_id: visitorId, completions, sessionId} per visitor, sessionId being the
// stay of that first conversion. The adapter then reads those visitor rows and
// those stays by their unique keys in batches (attributionLookups) and
// attributes them with the shared fold: a $lookup per converter here was two
// sub-pipelines per person and cost most of the read.
export function attributionConvertersPipeline(
  siteId: string,
  span: Range,
  goal: GoalMatch,
): Document[] {
  return [
    { $match: goalMatch(siteId, span, false, goal) },
    { $sort: { visitorId: 1, ts: 1, sessionId: 1 } },
    {
      $group: {
        _id: '$visitorId',
        completions: { $sum: 1 },
        sessionId: { $first: '$sessionId' },
      },
    },
  ];
}

// How many ids one $in carries. Each batch is one walk of a unique index.
export const ATTRIBUTION_LOOKUP_BATCH = 5000;

// The two reads by unique key: the converters' visitor rows (only their first
// touch) and the stays they converted in (only the fields a touch shares).
export function attributionLookups(
  siteId: string,
  visitorIds: readonly string[],
  sessionIds: readonly string[],
): { visitors: { filter: Document; projection: Document }; stays: { filter: Document; projection: Document } } {
  return {
    visitors: {
      filter: { siteId, id: { $in: [...visitorIds] } },
      projection: { _id: 0, id: 1, firstTouch: 1 },
    },
    stays: {
      filter: { siteId, id: { $in: [...sessionIds] } },
      projection: { _id: 0, id: 1, channel: 1, referrer: 1, utm: 1, entryPath: 1 },
    },
  };
}
