import type { GeoLocation } from '@chokh/geo/types';

// This file is also reachable on its own as @chokh/store/contract, because the
// dashboard needs the shapes the API answers with and cannot have the barrel:
// the barrel re-exports the session fold, which imports node:crypto. A browser
// importing a type it cannot resolve is a build that fails for a reason nobody
// can read, so the two consumers get two doors and one set of types.

import { addDays, dayBounds, dayKey, shiftYears, type Interval } from './time.js';
import type { Attributes, EventType, StoredEvent, StoredSession, Touch } from './types.js';

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

// The dimensions only a session carries. Nothing on a raw event says which
// page a stay came in on or what channel brought it, so visitors and pageviews
// for these three are counted off the session rows too.
export const SESSION_DIMENSIONS: readonly Dimension[] = ['entry', 'exit', 'channel'];

// The dimensions a day is rolled up by. Every adapter rolls the same list, or
// two adapters would file a year of history under different keys.
export const ROLLED_DIMENSIONS: readonly Dimension[] = [
  'page',
  'entry',
  'exit',
  'channel',
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
const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_HOUR_RANGE_DAYS = 7;
export const MAX_HOUR_RANGE_MS = MAX_HOUR_RANGE_DAYS * 24 * 60 * 60 * 1000;

// A minute series is the live view: the last half hour, a point a minute. It
// reads raw rows the way an hourly series does and is capped far harder,
// because a minute of a busy site is the same number of rows as an hour of a
// quiet one and nobody reads a chart of four thousand points. Three hours is
// 180 points, which is already more than the sparkline it exists for needs.
export const MAX_MINUTE_RANGE_HOURS = 3;
export const MAX_MINUTE_RANGE_MS = MAX_MINUTE_RANGE_HOURS * 60 * 60 * 1000;

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
// - visits, bounces and avgDurationMs are counted off sessions, and a session
//   belongs to the day it began on. A stay that crosses midnight is one visit,
//   on the day it started.
// - a bounce is a session with at most one pageview.
// - bounceRate is bounces over visits, null when there were no visits.
// - the three session numbers attribute to every dimension a session row
//   carries, which is all of them except page, screen, lang and event: a visit
//   spans pages, so it cannot be one of them, and those read 0 and null.
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

// How long a page held somebody and how far down it they got.
//
// Both numbers are read from leave beacons and from nowhere else. A leave
// carries the time on page and the scroll quartile of the page it closes, one
// per page rather than one per stay, so this is a measurement and not the gap
// between two pageviews: the last page of a visit has no following pageview to
// subtract from, and it is the page most worth knowing about.
//
// leaves is on the row because it is the sample size. A page with one leave
// has an average of one, and a report that hides that is inviting somebody to
// act on it.
export interface EngagementRow {
  key: string;
  avgTimeOnPageMs: number | null;
  avgScrollDepth: number | null;
  leaves: number;
}

export interface EngagementResult {
  dim: Dimension;
  rows: EngagementRow[];
  // Leaves are raw rows, so this report only sees as far back as the site
  // keeps them. A rollup holds no leave, and inventing one later would mean
  // writing a number nobody measured.
  rawOnly: true;
}

// Online means a sign of life within the last minute, and "since" is the start
// of the stay, so "online for 12 minutes" counts from the session. Both are
// read off the presence set, never off raw events.
export const ONLINE_WINDOW_MS = 60_000;
export const REALTIME_WINDOW_MS = 30 * 60_000;

export interface RealtimeVisitor {
  visitorId: string;
  userId?: string;
  path?: string;
  country?: string;
  city?: string;
  // Where the city is, to two decimal places. Rounded at the presence entry,
  // so this is a place on a map and never a person at an address.
  lat?: number;
  lon?: number;
  browser?: string;
  os?: string;
  device?: string;
  ip?: string;
  since: number;
  lastSeenAt: number;
}

// A city tally carries where to draw it. The key is the city name and the row
// is identified by the city and the country together, so two places that share
// a name are two rows rather than one wrong one.
export interface CityCountRow extends CountRow {
  country?: string;
  lat?: number;
  lon?: number;
}

// How many of the last half hour are kept beside the online list. A quiet hour
// should not read as a broken page, and a busy site should not send its whole
// half hour down an SSE frame every five seconds.
export const MAX_RECENT_VISITORS = 50;

export interface RealtimeSnapshot {
  online: number;
  signedIn: number;
  anonymous: number;
  byPage: CountRow[];
  byCountry: CountRow[];
  byCity: CityCountRow[];
  visitors: RealtimeVisitor[];
  // Seen inside the presence window but not inside the online one: the people
  // who were here a few minutes ago. Newest first, capped.
  recent: RealtimeVisitor[];
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
  // What first brought them here, and what brought them back last.
  firstTouch?: Touch;
  lastTouch?: Touch;
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
  visitors: number;
}

// Where a comparison reads from.
//
// previous_year is the same wall clock a year earlier, which is not the same
// number of milliseconds and is the point.
//
// previous_period is the range again, ending where this one starts, and that is
// exactly right for an hourly window and exactly wrong for a daily one. A seven
// day range runs from a midnight to now, so subtracting its length lands the
// previous window in the middle of a day: its first bucket is the few hours
// after that instant rather than a whole day, the dashed line starts at a
// sliver against a real number, and every bucket after it is offset by the same
// fraction of a day. Read at a day or coarser, the previous window is therefore
// the same count of whole days, day aligned, so bucket one compares with bucket
// one.
//
// This is decided here rather than in the two adapters, because a comparison
// that means one thing in memory and another in MongoDB is the bug the read
// plan already taught this codebase once.
export function comparisonRange(
  range: Range,
  compare: Compare,
  timezone: string,
  interval?: Interval,
): Range {
  if (compare === 'previous_year') {
    return { from: shiftYears(range.from, -1, timezone), to: shiftYears(range.to, -1, timezone) };
  }
  if (interval === undefined || interval === 'minute' || interval === 'hour') {
    const length = range.to - range.from;
    return { from: range.from - length, to: range.from };
  }
  // The calendar days this range touches, counted in the site's own zone: the
  // day from began in, through the day the last instant before to falls in.
  const firstKey = dayKey(range.from, timezone);
  const lastKey = dayKey(range.to - 1, timezone);
  const start = dayBounds(firstKey, timezone).start;
  const days = Math.max(1, Math.round((dayBounds(lastKey, timezone).start - start) / DAY_MS) + 1);
  return { from: dayBounds(addDays(firstKey, -days), timezone).start, to: start };
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
  // The tracker strips the utm_ prefix before it sends the object, so a
  // campaign arrives as utm.source and not utm.utm_source. The dimension keeps
  // the name a person types into a link; the path is the name on the wire.
  utm_source: 'utm.source',
  utm_medium: 'utm.medium',
  utm_campaign: 'utm.campaign',
  utm_term: 'utm.term',
  utm_content: 'utm.content',
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

// Where the same dimension lives on a session row. A session is where a visit,
// a bounce and a duration come from, so every dimension a visit can be
// attributed to has to be findable here. The four that are missing are the
// four a stay spans rather than has: a visit is not one page, one screen size,
// one language or one custom event.
export const SESSION_PATH_BY_DIMENSION: Readonly<Partial<Record<Dimension, string>>> = {
  entry: 'entryPath',
  exit: 'exitPath',
  channel: 'channel',
  referrer: 'referrer',
  utm_source: 'utm.source',
  utm_medium: 'utm.medium',
  utm_campaign: 'utm.campaign',
  utm_term: 'utm.term',
  utm_content: 'utm.content',
  country: 'geo.country',
  region: 'geo.region',
  city: 'geo.city',
  browser: 'ua.browser',
  os: 'ua.os',
  device: 'ua.device',
  bot: 'bot',
};

function readPath(row: object, path: string): string | undefined {
  let cursor: unknown = row;
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

export function dimensionValue(event: StoredEvent, dim: Dimension): string | undefined {
  const path = EVENT_PATH_BY_DIMENSION[dim];
  return path === undefined ? undefined : readPath(event, path);
}

export function sessionDimensionValue(
  session: StoredSession,
  dim: Dimension,
): string | undefined {
  const path = SESSION_PATH_BY_DIMENSION[dim];
  return path === undefined ? undefined : readPath(session, path);
}

function matches(value: string | undefined, filter: Filter): boolean {
  if (filter.op === 'contains') {
    return value !== undefined && value.includes(filter.value);
  }
  const equal = value === filter.value;
  return filter.op === 'is' ? equal : !equal;
}

export function matchesFilter(event: StoredEvent, filter: Filter): boolean {
  if (filter.dim === BOT_DIMENSION) {
    return event.bot === botSelector([filter]);
  }
  return matches(dimensionValue(event, filter.dim), filter);
}

export function matchesSessionFilter(session: StoredSession, filter: Filter): boolean {
  if (filter.dim === BOT_DIMENSION) {
    return session.bot === botSelector([filter]);
  }
  return matches(sessionDimensionValue(session, filter.dim), filter);
}

// A filter has to be answerable by the rows it is put to. Every dimension an
// event carries can narrow an event read, and the three only a session carries
// cannot: the events of a stay do not know which page it came in on. Answering
// that with an empty report would be a silent wrong number, so it is refused
// instead, and AN-SEG01 owns the segment that resolves it properly.
export function assertFilterable(filters: Filter[] | undefined): void {
  for (const filter of filters ?? []) {
    if (SESSION_DIMENSIONS.includes(filter.dim)) {
      throw new StoreQueryError(
        'UNSUPPORTED_FILTER',
        `A raw event does not carry ${filter.dim}, so a report cannot be filtered by it yet`,
      );
    }
  }
}

// How long a range may be for the interval it asked for. Both caps exist for
// the same reason: neither a minute nor an hour has a rollup, so both read raw
// rows for the whole range, and a chart nobody can read is not worth the scan.
// One function, so two adapters cannot cap at two lengths.
export function assertIntervalRange(interval: Interval, from: number, to: number): void {
  if (interval === 'hour' && to - from > MAX_HOUR_RANGE_MS) {
    throw new StoreQueryError(
      'RANGE_TOO_LONG',
      `An hourly series reads raw rows, so it is capped at ${MAX_HOUR_RANGE_DAYS} days. Ask for days instead.`,
    );
  }
  if (interval === 'minute' && to - from > MAX_MINUTE_RANGE_MS) {
    throw new StoreQueryError(
      'RANGE_TOO_LONG',
      `A minute series reads raw rows, so it is capped at ${MAX_MINUTE_RANGE_HOURS} hours. Ask for hours instead.`,
    );
  }
}

// An engagement read groups leave beacons, which are events, so it can answer
// for every dimension an event carries and for none of the three only a stay
// does. Refused rather than answered empty, for the same reason a filter
// naming one is: an empty report reads as nobody came.
export function assertEngageable(dim: Dimension | undefined): Dimension {
  if (dim === undefined) {
    throw new StoreQueryError('MISSING_DIMENSION', 'An engagement read needs a dim');
  }
  if (EVENT_PATH_BY_DIMENSION[dim] === undefined) {
    throw new StoreQueryError(
      'UNSUPPORTED_DIMENSION',
      `A leave beacon does not carry ${dim}, so time on page cannot be grouped by it`,
    );
  }
  return dim;
}

// Whether the session side can answer a filtered read at all. A filter naming
// something a stay spans rather than has (a page, a screen, a language, an
// event name) leaves the visit numbers unanswerable, so they read 0 and null
// rather than pretending the filter did not apply.
export function sessionsAnswerFilters(filters: Filter[] | undefined): boolean {
  return (filters ?? []).every(
    (filter) => SESSION_PATH_BY_DIMENSION[filter.dim] !== undefined,
  );
}
