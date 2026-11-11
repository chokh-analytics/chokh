import { ERROR_FACET_LIMIT, VITAL_METRICS, VITAL_SCALES, type Range } from '@chokh/store';
import type { Document } from 'mongodb';

// Health (AN-VIT01). Each read starts with one walk of an events index and
// folds inside the pipeline, so what crosses the wire is one small histogram
// per page, device and metric, one row per error message or one row per
// identified person, and never a row per event. health.ts in @chokh/store holds
// the same rules in JS for the in-memory adapter and the fold both answer
// through; the conformance suite holds the two to one answer.
//
// The vitals and error reads walk event_site_type_ts, so they read only their
// own rows. On a database migrate has not reached yet they walk event_site_ts
// with the type as a filter, slower and the same answer.

function rowsOf(siteId: string, type: 'vital' | 'error', range: Range): Document {
  return { siteId, type, ts: { $gte: range.from, $lt: range.to }, bot: false };
}

const PAGE = { $ifNull: ['$route', { $ifNull: ['$path', ''] }] };

// The bucket of one measurement, written as health.ts's vitalBucket writes it:
// the same additions, products and roundings of the same doubles, so the two
// adapters cannot disagree about which bucket a value is in. Null for a value
// nobody could have measured (NaN sorts below every number here, so it is
// caught by the first test).
const CLS_MAX = VITAL_SCALES.CLS.max;
const MS_MAX = VITAL_SCALES.LCP.max;

export const vitalBucketExpression: Document = {
  $cond: [
    {
      $or: [
        { $lt: ['$value', 0] },
        { $gt: ['$value', { $cond: [{ $eq: ['$name', 'CLS'] }, CLS_MAX, MS_MAX] }] },
      ],
    },
    null,
    {
      $cond: [
        { $eq: ['$name', 'CLS'] },
        { $ceil: { $divide: [{ $floor: { $add: [{ $multiply: ['$value', 1000] }, 0.5] } }, 10] } },
        { $ceil: { $divide: [{ $floor: { $add: ['$value', 0.5] } }, 10] } },
      ],
    },
  ],
};

// One {_id: {p, d, m}, buckets: [{q, n}]} per page, device and metric. The
// second group pushes bucket counts, never the measurements, so no group grows
// with traffic past the few thousand buckets a metric can have.
export function vitalsPipeline(siteId: string, range: Range, device?: string): Document[] {
  return [
    {
      $match: {
        ...rowsOf(siteId, 'vital', range),
        name: { $in: [...VITAL_METRICS] },
        value: { $type: 'number' },
        ...(device === undefined ? {} : { 'ua.device': device }),
      },
    },
    {
      $project: {
        _id: 0,
        p: PAGE,
        d: { $ifNull: ['$ua.device', ''] },
        m: '$name',
        q: vitalBucketExpression,
      },
    },
    { $match: { q: { $ne: null } } },
    { $group: { _id: { p: '$p', d: '$d', m: '$m', q: '$q' }, n: { $sum: 1 } } },
    {
      $group: {
        _id: { p: '$_id.p', d: '$_id.d', m: '$_id.m' },
        buckets: { $push: { q: '$_id.q', n: '$n' } },
      },
    },
  ];
}

// The error reads are three, each a walk of the range's error rows. The first
// answers the biggest messages, cut in the database in the order foldErrors
// sorts by, and how many messages there are; the second, the distinct visitors
// and the pages and browsers of those messages only; the third, every row and
// every visitor of the range. Three walks of rows that are rare rather than one
// $facet, because a $facet answers one document and a site with ten thousand
// distinct messages and their stacks would not fit in it.
export function errorMessagesPipeline(siteId: string, range: Range, limit: number): Document[] {
  return [
    { $match: rowsOf(siteId, 'error', range) },
    // Newest first, so $first below is the newest row of each message. The
    // index walks backwards to give this order, so it is no SORT stage.
    { $sort: { ts: -1 } },
    {
      $group: {
        _id: { $ifNull: ['$name', ''] },
        count: { $sum: 1 },
        firstSeen: { $min: '$ts' },
        lastSeen: { $max: '$ts' },
        sample: {
          $first: {
            at: '$ts',
            page: PAGE,
            browser: { $ifNull: ['$ua.browser', ''] },
            frame: '$frame',
            stack: '$stack',
          },
        },
      },
    },
    {
      $facet: {
        top: [{ $sort: { count: -1, lastSeen: -1, _id: 1 } }, { $limit: limit }],
        groups: [{ $count: 'n' }],
      },
    },
  ];
}

function topFacet(key: string | Document): Document[] {
  return [
    { $group: { _id: { m: '$m', k: key }, count: { $sum: 1 } } },
    { $sort: { '_id.m': 1, count: -1, '_id.k': 1 } },
    { $group: { _id: '$_id.m', top: { $push: { key: '$_id.k', count: '$count' } } } },
    { $project: { top: { $slice: ['$top', ERROR_FACET_LIMIT] } } },
  ];
}

export function errorFacetsPipeline(siteId: string, range: Range, messages: string[]): Document[] {
  return [
    { $match: rowsOf(siteId, 'error', range) },
    { $project: { _id: 0, m: { $ifNull: ['$name', ''] }, v: '$visitorId', p: PAGE, b: '$ua.browser' } },
    { $match: { m: { $in: messages } } },
    {
      $facet: {
        people: [{ $group: { _id: { m: '$m', v: '$v' } } }, { $group: { _id: '$_id.m', n: { $sum: 1 } } }],
        pages: topFacet('$p'),
        browsers: topFacet({ $ifNull: ['$b', ''] }),
      },
    },
  ];
}

export function errorTotalsPipeline(siteId: string, range: Range): Document[] {
  return [
    { $match: rowsOf(siteId, 'error', range) },
    { $group: { _id: '$visitorId', n: { $sum: 1 } } },
    { $group: { _id: null, visitors: { $sum: 1 }, total: { $sum: '$n' } } },
  ];
}

// One {_id: userId, server, browser} per person identified in the range. The
// match bounds userId to the non-empty strings, so the walk is of
// event_site_user_ts over the identified rows and the anonymous majority of
// the range is never read.
export function coveragePipeline(siteId: string, range: Range): Document[] {
  return [
    { $match: { siteId, userId: { $gt: '' }, ts: { $gte: range.from, $lt: range.to }, bot: false } },
    {
      $group: {
        _id: '$userId',
        server: { $max: { $eq: ['$source', 'server'] } },
        browser: { $max: { $ne: ['$source', 'server'] } },
      },
    },
  ];
}
