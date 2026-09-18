import type { GeoLocation } from '@chokh/geo';

import { shiftYears, type Interval } from './time.js';
import type { Attributes, EventType, StoredEvent } from './types.js';

// One query shape for every read. from is inclusive, to is exclusive, both in
// epoch milliseconds; the day, week and month a range is cut into are the
// site's own, never UTC's, unless the site says UTC.
export interface Query {
  siteId: string;
  from: number;
  to: number;
  filters?: Filter[];
  compare?: Compare;
  interval?: Interval;
  dim?: Dimension;
  limit?: number;
}

export type Compare = 'previous_period' | 'previous_year';

export interface Filter {
  dim: Dimension;
  op: 'is' | 'is_not' | 'contains';
  value: string;
}

export type Dimension =
  | 'page'
  | 'entry'
  | 'exit'
  | 'referrer'
  | 'channel'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'utm_term'
  | 'utm_content'
  | 'country'
  | 'region'
  | 'city'
  | 'browser'
  | 'os'
  | 'device'
  | 'screen'
  | 'lang'
  | 'event'
  | 'bot';

export const DIMENSIONS: readonly Dimension[] = [
  'page',
  'entry',
  'exit',
  'referrer',
  'channel',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'screen',
  'lang',
  'event',
  'bot',
];

// The dimensions a session carries. AN-STO01 declares and indexes the sessions
// collection but does not write it: AN-SES01 owns the 30 minute gap rule and
// the channel classifier. Until then these break down to nothing.
export const SESSION_DIMENSIONS: readonly Dimension[] = ['entry', 'exit', 'channel'];

// The dimensions a raw event carries, and therefore the ones a day is rolled
// up by. Every adapter rolls the same list, or two adapters would file a year
// of history under different keys.
export const ROLLED_DIMENSIONS: readonly Dimension[] = [
  'page',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'screen',
  'lang',
  'event',
];

// A read excludes bots unless the query asks for them by name. This is why
// 'bot' is a dimension rather than a flag beside the range: the shape stays
// {from, to, filters, compare, interval, dim, limit} and a dashboard can still
// ask "what share of this was a crawler" with one filter.
export const BOT_DIMENSION: Dimension = 'bot';

// Rollups are daily, so an hourly series has to read raw events for the whole
// range and not only for today. Raw rows are the expensive ones, so an hourly
// range is capped: a week of hours is 168 points, which is already more than a
// chart can show, and anything longer belongs on the day interval.
export const MAX_HOUR_RANGE_DAYS = 7;
export const MAX_HOUR_RANGE_MS = MAX_HOUR_RANGE_DAYS * 24 * 60 * 60 * 1000;

// How many rows a breakdown answers with when the query names no limit.
export const DEFAULT_BREAKDOWN_LIMIT = 100;

export class StoreQueryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreQueryError';
    this.code = code;
  }
}

// What a number means, in one place, because a rollup makes some of these
// choices for us:
//
// - visitors over a range of days is the sum of each day's unique visitors. A
//   daily rollup cannot hold anything else, and a person who came on Monday
//   and again on Tuesday counts twice in a Monday to Tuesday total. Within one
//   day it is an exact distinct count.
// - visits, bounces, bounceRate and avgDurationMs come from sessions, which
//   AN-SES01 writes. Until it lands they are 0 and null.
// - bounceRate is bounces over visits, null when there were no visits.
export interface Metrics {
  visitors: number;
  pageviews: number;
  visits: number;
  bounces: number;
  bounceRate: number | null;
  avgDurationMs: number | null;
}

export function emptyMetrics(): Metrics {
  return { visitors: 0, pageviews: 0, visits: 0, bounces: 0, bounceRate: null, avgDurationMs: null };
}

export interface Range {
  from: number;
  to: number;
}

export interface AggregateResult {
  range: Range;
  metrics: Metrics;
  // Present only when the query carried a compare.
  previousRange: Range | null;
  previous: Metrics | null;
}

export interface TimeseriesPoint {
  start: number;
  end: number;
  metrics: Metrics;
}

export interface TimeseriesResult {
  interval: Interval;
  points: TimeseriesPoint[];
  previous: TimeseriesPoint[] | null;
}

export interface BreakdownRow {
  key: string;
  metrics: Metrics;
}

export interface BreakdownResult {
  dim: Dimension;
  rows: BreakdownRow[];
}

export interface CountRow {
  key: string;
  visitors: number;
}

// Online means an event within the last minute. "since" is the first event of
// the visitor's current half hour, which is what a stay looks like before
// AN-SES01 gives it a session row.
export const ONLINE_WINDOW_MS = 60_000;
export const REALTIME_WINDOW_MS = 30 * 60_000;

export interface RealtimeVisitor {
  visitorId: string;
  userId?: string;
  path?: string;
  country?: string;
  city?: string;
  browser?: string;
  os?: string;
  device?: string;
  ip?: string;
  since: number;
  lastSeenAt: number;
}

export interface RealtimeSnapshot {
  online: number;
  signedIn: number;
  anonymous: number;
  byPage: CountRow[];
  byCountry: CountRow[];
  visitors: RealtimeVisitor[];
}

export interface TimelineEntry {
  ts: number;
  type: EventType;
  path?: string;
  name?: string;
}

export interface VisitorProfile {
  siteId: string;
  visitorId: string;
  userId?: string;
  traits?: Attributes;
  firstSeenAt: number;
  lastSeenAt: number;
  pageviews: number;
  events: number;
  sessions: number;
  // Where they usually connect from: the location seen most often.
  homeGeo?: GeoLocation;
  devices: string[];
  ips: string[];
  timeline: TimelineEntry[];
}

export interface UserProfile extends Omit<VisitorProfile, 'visitorId'> {
  userId: string;
  visitorIds: string[];
}

export interface RollupSummary {
  siteId: string;
  date: string;
  rows: number;
  visitors: number;
  pageviews: number;
}

export interface PurgeSummary {
  events: number;
  sessions: number;
}

// Where a comparison reads from. previous_period is the range again, ending
// where this one starts; previous_year is the same wall clock a year earlier,
// which is not the same number of milliseconds and is the point.
export function comparisonRange(range: Range, compare: Compare, timezone: string): Range {
  if (compare === 'previous_period') {
    const length = range.to - range.from;
    return { from: range.from - length, to: range.from };
  }
  return { from: shiftYears(range.from, -1, timezone), to: shiftYears(range.to, -1, timezone) };
}

// A daily rollup holds one dimension at a time, never the cube, so a read
// filtered by anything other than bot cannot be answered from it and falls
// back to raw events for the whole range. Raw retention is therefore how far
// back a filtered report can see, which is worth saying out loud to a site
// owner who lowers it.
//
// A bot filter on its own is the exception: rollupDay writes a bot series
// beside the totals. Crossed with a breakdown dimension it is not, so that
// reads raw too.
export function needsRawRows(filters: Filter[] | undefined, dim?: Dimension): boolean {
  if (filters === undefined || filters.length === 0) {
    return false;
  }
  const onlyBot = filters.every((filter) => filter.dim === BOT_DIMENSION);
  return !onlyBot || dim !== undefined;
}

// Which side of the bot line a read is asking for. Nothing said means the
// visitors, not the crawlers.
export function botSelector(filters: Filter[] | undefined): boolean {
  const filter = filters?.find((candidate) => candidate.dim === BOT_DIMENSION);
  if (filter === undefined) {
    return false;
  }
  const asked = filter.value === 'true';
  return filter.op === 'is_not' ? !asked : asked;
}

// Where a dimension lives on a raw event. One map, so the in-memory adapter
// reading a property and the MongoDB adapter grouping on a field path can
// never drift apart. The three that are missing belong to a session, which
// AN-SES01 writes.
export const EVENT_PATH_BY_DIMENSION: Readonly<Partial<Record<Dimension, string>>> = {
  page: 'path',
  referrer: 'referrer',
  utm_source: 'utm.utm_source',
  utm_medium: 'utm.utm_medium',
  utm_campaign: 'utm.utm_campaign',
  utm_term: 'utm.utm_term',
  utm_content: 'utm.utm_content',
  country: 'geo.country',
  region: 'geo.region',
  city: 'geo.city',
  browser: 'ua.browser',
  os: 'ua.os',
  device: 'ua.device',
  screen: 'screen',
  lang: 'lang',
  event: 'name',
  bot: 'bot',
};

export function dimensionValue(event: StoredEvent, dim: Dimension): string | undefined {
  const path = EVENT_PATH_BY_DIMENSION[dim];
  if (path === undefined) {
    return undefined;
  }
  let cursor: unknown = event;
  for (const step of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[step];
  }
  if (cursor === undefined || cursor === null) {
    return undefined;
  }
  return String(cursor);
}

export function matchesFilter(event: StoredEvent, filter: Filter): boolean {
  if (filter.dim === BOT_DIMENSION) {
    return event.bot === botSelector([filter]);
  }
  const value = dimensionValue(event, filter.dim);
  if (filter.op === 'contains') {
    return value !== undefined && value.includes(filter.value);
  }
  const equal = value === filter.value;
  return filter.op === 'is' ? equal : !equal;
}
