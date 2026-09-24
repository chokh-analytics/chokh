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
  // Which goal to count conversions against. Honoured by aggregate and
  // breakdown, which then answer a conversion beside the metrics; refused by
  // timeseries and engagement rather than ignored. A query with a goal reads raw
  // rows for the whole range: see conversionMatcher below for why.
  goal?: GoalRead;
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
  // What the page answered, when the page says so. A browser cannot see a
  // response code, so this is absent unless a page declares it, and absent is
  // not 200: a pageview nobody labelled is a pageview nobody labelled.
  | 'status'
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
  'status',
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
  // Every value of this widens the rollup key space for good: one more row per
  // site, per day, per status a page declared. Three digits and nothing else
  // is what keeps that bounded, which is why the collect schema refuses
  // anything that is not one.
  'status',
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
  // Present only when the query carried a goal; the previous one only when it
  // carried a compare as well.
  conversion?: Conversion;
  previousConversion?: Conversion | null;
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
  // Present on every row when the query carried a goal.
  conversion?: Conversion;
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
  // A percentage and not a fraction: the tracker reports a quartile as 0, 25,
  // 50, 75 or 100 and this is the mean of those numbers, so three quarters of
  // a page is 75. Named here because a reader who guesses gets a report that
  // is out by a hundred, which is exactly what shipped.
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

// Two decimal places, and the rounding is a rule of the contract rather than a
// habit of one adapter, because what makes a coordinate publishable is that
// nothing more precise was ever kept. It lives here rather than beside the
// presence set because a dashboard has to apply it too: a visitor profile's
// home location comes off the visitor row, which the geo database wrote at full
// precision, and a second copy of this arithmetic in a page is a second thing
// that can disagree about what "publishable" means.
export const COORDINATE_DECIMALS = 2;

export function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  const rounded = Math.round(value * factor) / factor;
  // A place a hair west of Greenwich rounds to negative zero, which is a real
  // number in JavaScript and a surprise everywhere else. Zero is zero.
  return rounded === 0 ? 0 : rounded;
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
  // Which stay this belongs to, so a profile can group fifty events into the
  // four visits they actually were. Stamped by ingest under the thirty minute
  // gap rule; absent only on a row written before that stamping existed.
  sessionId?: string;
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

// A goal: a page being viewed or a custom event being sent, counted as a
// success.
//
// A page goal matches the path the way the tracker sends it, and a * stands
// for any run of characters inside one segment of it, so /*/checkout/done is
// the same page in every locale prefix. An event goal matches one name
// exactly. Nothing is counted when a goal is written: a goal is a question
// asked of the raw events, which is why one created today answers for every day
// those events still cover, and why deleting and adding it again brings its
// numbers back.
export type GoalKind = 'page' | 'event';

export const GOAL_KINDS: readonly GoalKind[] = ['page', 'event'];

export interface GoalMatch {
  kind: GoalKind;
  match: string;
}

export interface Goal extends GoalMatch {
  siteId: string;
  // Derived from the site, the kind and the match (goalIdFor), so the same
  // question asked twice is the same row and the unique index refuses it.
  id: string;
  name: string;
  // A plain number counted once per completion. No unit, on purpose: a sum of
  // taka and dollars is not a number anybody can act on, and revenue with a
  // currency is a feature of its own.
  value?: number;
  // Who added it: a dashboard user's id, or the id of the key that did.
  createdBy: string;
  createdAt: number;
}

// How many goals a site may have. Every goal read tags each matching row with
// the goals it matches, so this is a bound on the work of one read as much as a
// bound on a list somebody has to scroll.
export const MAX_GOALS_PER_SITE = 50;

// What a read needs to know about a goal: the question, and what a completion
// is worth.
export interface GoalRead extends GoalMatch {
  value?: number;
}

// How many of a row's visitors reached a goal, and what that was worth.
//
// The definition, in one place because two adapters must not disagree about
// it: on each day of the site's calendar, a visitor converted if a conversion
// event of theirs happened that day, and a row's converted visitors are, day by
// day, the visitors counted in that row that day who also converted that day,
// added up over the range. So it is the same arithmetic as visitors, a person
// converting on two days counts twice, and a rate can never pass one: the
// people who converted in a row are always some of the people in it.
//
// A row's membership comes from whatever counts that row's visitors already:
// the events for every dimension an event carries, the stays for entry, exit and
// channel. The conversion event does not have to carry the dimension itself,
// which matters, because a server event has no country and a custom event has
// no campaign: an order paid by somebody who came from a campaign that day
// counts in that campaign's row.
//
// The query's filters narrow the people a conversion is counted against and
// never the goal: "of the people who read /pricing, how many signed up" does
// not need the signup to happen on /pricing.
export interface Conversion {
  // Converted visitors, each day's added up.
  visitors: number;
  // Conversion events of those visitors on those days.
  completions: number;
  // visitors over the row's visitors; null over nobody.
  rate: number | null;
  // completions times the goal's value; null when the goal has none.
  value: number | null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A page goal's match as an anchored pattern: * is any run of characters inside
// one segment of the path, and nothing else is special, so a path containing
// a dot or a bracket means that dot or that bracket. One function, so the
// in-memory test and MongoDB's $regex are the same pattern.
export function goalPattern(match: string): string {
  return `^${match.split('*').map(escapeRegex).join('[^/]*')}$`;
}

// Whether a page goal needs a pattern at all. A match with no * is a plain
// equality, which is cheaper to ask of every row and is what most goals are.
export function goalIsPattern(goal: GoalMatch): boolean {
  return goal.kind === 'page' && goal.match.includes('*');
}

// Whether a stored row reached a goal. A page goal is reached by a pageview of
// a matching path and by nothing else, so a leave beacon or an event on that
// page does not count twice; an event goal by a custom event of that exact
// name, a server's included. The bot side is the caller's: a read excludes bots
// unless it asked for them, and a conversion follows the read.
//
// Why a goal read is raw for the whole range, denominator included: a daily
// rollup holds counts, one dimension at a time, and a conversion is an overlap
// between two sets of people. A rolled goal dimension would not help either:
// goals are defined after the fact, so its rows would be empty for every day
// before the goal existed, and a backfill can only re-roll days whose raw events
// still exist, which is the window a raw read already sees. Reading both halves
// from the same rows is what keeps a rate from dividing a raw count by a rolled
// one.
export function conversionMatcher(goal: GoalMatch): (event: StoredEvent) => boolean {
  if (goal.kind === 'event') {
    return (event) => event.type === 'event' && event.name === goal.match;
  }
  if (!goalIsPattern(goal)) {
    return (event) => event.type === 'pageview' && event.path === goal.match;
  }
  const pattern = new RegExp(goalPattern(goal.match));
  return (event) => event.type === 'pageview' && event.path !== undefined && pattern.test(event.path);
}

export function finishConversion(
  converted: { visitors: number; completions: number },
  base: number,
  goal: GoalRead,
): Conversion {
  return {
    visitors: converted.visitors,
    completions: converted.completions,
    rate: base === 0 ? null : converted.visitors / base,
    value: goal.value === undefined ? null : converted.completions * goal.value,
  };
}

// The two reads a goal cannot be asked of yet. Refused rather than ignored,
// because a chart that silently dropped the goal would draw every visitor under
// a heading that says conversions.
const GOALLESS_READS = {
  timeseries: 'A time series',
  engagement: 'A time on page read',
  events: 'The events report',
  properties: 'A property breakdown',
  funnel: 'A funnel',
  journeys: 'The journeys report',
} as const;

export function assertNoGoal(query: Query, read: keyof typeof GOALLESS_READS): void {
  if (query.goal !== undefined) {
    throw new StoreQueryError(
      'UNSUPPORTED_GOAL',
      `${GOALLESS_READS[read]} cannot be counted against a goal yet`,
    );
  }
}

// The events report and a property breakdown. Both read raw rows only: a
// rollup keeps visitors per event name and never how many times it happened,
// and a property is not a dimension at all, so neither has any history to fall
// back on and each sees back as far as the site keeps its events.
//
// visitors is the range's own, under the same filters, and a row's rate is its
// visitors over it: the share of the people who were here that did this.
export interface EventRow {
  key: string;
  visitors: number;
  events: number;
  rate: number | null;
}

export interface EventsResult {
  visitors: number;
  rows: EventRow[];
  rawOnly: true;
}

// A property breakdown names one custom event and, optionally, one of its
// properties. Without one it answers the most used, so a first look needs one
// read and not two.
export interface PropertyQuery extends Query {
  event: string;
  property?: string;
}

export interface PropertyCount {
  key: string;
  events: number;
}

// How many property names a breakdown lists. A property name is whatever a page
// passed, so this bounds a list nobody chose the length of.
export const MAX_PROPERTY_KEYS = 50;

export interface PropertyResult {
  event: string;
  // Every property name the event carried in the range, most used first.
  properties: PropertyCount[];
  // The one the rows break down by: the one asked for, else the most used,
  // else null when the event carried none.
  property: string | null;
  visitors: number;
  // One row per value. An event that did not carry the property is the ''
  // row, which is drawn as unknown rather than dropped: a breakdown whose rows
  // do not add up to the event is a breakdown that hid something.
  rows: EventRow[];
  rawOnly: true;
}

// A funnel: steps a visitor takes in order, each a goal's question, within a
// window.
//
// A step is a copy of a question, not a pointer to a goal. The builder offers
// a site's goals and a typed path, and a step made from a goal keeps the goal's
// kind and match and remembers goalId only to say where it came from. So
// deleting a goal changes no funnel: the goal was a question, the funnel still
// asks it, and nothing was counted under either when they were written.
//
// The window is how long a visitor has, from the first step to the last. visit
// is the other kind of window: every step inside one stay, however long that
// stay lasts. Which one a funnel wants is the site owner's choice per funnel,
// because "did they finish in one sitting" and "did they come back and finish
// within a week" are both real questions.
export type FunnelWindow = 'visit' | '1h' | '1d' | '7d' | '30d';

export const FUNNEL_WINDOWS = [
  'visit',
  '1h',
  '1d',
  '7d',
  '30d',
] as const satisfies readonly FunnelWindow[];

const HOUR_MS = 60 * 60 * 1000;

export const FUNNEL_WINDOW_MS: Readonly<Record<Exclude<FunnelWindow, 'visit'>, number>> = {
  '1h': HOUR_MS,
  '1d': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

// What a builder offers first. A site that remembers its visitors across days
// can follow a chain across days; a cookieless visitor id is a daily hash, so
// on such a site no chain can cross midnight and a longer window would only
// look like it works.
export function defaultFunnelWindow(visitorIdMode: 'cookieless' | 'persistent'): FunnelWindow {
  return visitorIdMode === 'persistent' ? '7d' : 'visit';
}

// A funnel of one step is a goal. Eight is room for the longest real path a
// site has named (page, pricing, checkout, paid, first use) with some to
// spare, and every step is one more pass of the fold over every row a read
// looks at, so the ceiling is a bound on work as well as on a form.
export const MIN_FUNNEL_STEPS = 2;
export const MAX_FUNNEL_STEPS = 8;

// How many funnels a site may have, for the reason goals have a ceiling.
export const MAX_FUNNELS_PER_SITE = 50;

export interface FunnelStep extends GoalMatch {
  name: string;
  // The goal this step was copied from, when it was. Provenance only: nothing
  // reads the goal again.
  goalId?: string;
}

export interface Funnel {
  siteId: string;
  // Derived from the site, the window and the steps in order (funnelIdFor),
  // so the same funnel asked twice is the same row and the unique index
  // refuses it. The name is not part of the question.
  id: string;
  name: string;
  steps: FunnelStep[];
  window: FunnelWindow;
  createdBy: string;
  createdAt: number;
}

// What a read needs of a funnel: the questions in order, and the window.
export interface FunnelRead {
  steps: GoalMatch[];
  window: FunnelWindow;
}

// How many people got how far, in one place because two adapters must not
// disagree about it:
//
// - Counted per visitor over the whole range, never per day. A chain begun on
//   Monday and finished on Tuesday belongs to neither day, and a seven day
//   window cut into days is a one day window. So the first step is distinct
//   people over the range, which over several days is not the Visitors figure:
//   that one adds up each day's uniques.
// - A visitor reached step k when there are rows r1 .. rk, each ri reaching step
//   i the way a row reaches a goal (conversionMatcher), taken in time order,
//   with rk no later than the window after r1. With the visit window every ri is
//   in one stay and there is no other bound. Every row lies inside the range:
//   the range bounds each step, the window bounds the chain.
// - Anything between two steps is ignored, one row counts for one step of one
//   chain (so a funnel of /home then /home needs two views of /home), and
//   repeating the first step starts a new clock without undoing what an earlier
//   chain reached. At equal times rows are taken in step order (see
//   compareFunnelRows), so both adapters chain them the same way.
// - The query's filters narrow the people and never the steps, the rule a
//   conversion keeps: a visitor is in the segment when a row of theirs in the
//   range matches every filter an event carries and, for entry, exit and
//   channel, a stay of theirs that began in the range matches every one of
//   those. The steps are then counted among those people, wherever they
//   happened.
export interface FunnelStepResult {
  // Reached this step, and every one before it, in order, within the window.
  visitors: number;
  // The previous step's visitors minus this; 0 on the first step.
  dropOff: number;
  // This over the first step; null over nobody.
  rate: number | null;
  // This over the previous step; null on the first step and over nobody.
  stepRate: number | null;
}

export interface FunnelResult {
  // The segment: distinct people in the range under the filters.
  visitors: number;
  steps: FunnelStepResult[];
  rawOnly: true;
}

// Journeys: the paths visits took, from the page they came in on through the
// next three.
//
// A journey is a visit that began in the range and viewed at least one page:
// its pageviews in time order, with a page repeated back to back counted once,
// because a reload is not a step. A visit with no pageview (an identify alone,
// a server event) took no path. The unit is visits and not visitors: a path is
// a fact about one visit, and a person who came twice took two.
//
// Four columns. Each keeps its most visited pages, up to the branch count, and
// folds every other page of that column into one Other node (key null), chosen
// per column over every visit that reached it, so a page is one node however
// it was reached. A visit folded into Other keeps the pages after it. Every
// node says how many visits ended there, and the last column says how many
// went on past it, so every column adds up.
//
// The query's filters narrow the visits and never the path: a visit is in when
// its stay matches every filter only a stay carries and, when a filter names
// something a row carries, a row of that visit in the range matches all of
// them. Pages after the end of the range are not read, so a visit that crosses
// it is cut there; a range that ends now never cuts one.
export const JOURNEY_STEPS = 4;
export const DEFAULT_JOURNEY_BRANCHES = 5;
export const MAX_JOURNEY_BRANCHES = 10;

// How many pageviews of one visit a read looks at: the first fifty. A path is
// four pages, so anything past fifty only ever says the visit went on.
export const JOURNEY_ROWS_PER_VISIT = 50;

export interface JourneyQuery extends Query {
  branches?: number;
}

export interface JourneyNode {
  // The page, or null for the column's Other.
  key: string | null;
  visits: number;
  // Visits whose path ended at this node.
  exits: number;
  // Visits that went on past the last column. Zero in every other column.
  onward: number;
}

export interface JourneyLink {
  // From a node in this column to one in the next.
  column: number;
  from: string | null;
  to: string | null;
  visits: number;
}

export interface JourneyResult {
  visits: number;
  // Always JOURNEY_STEPS columns, empty past the longest path.
  columns: JourneyNode[][];
  links: JourneyLink[];
  branches: number;
  rawOnly: true;
}

export interface GoalStatsRow {
  goalId: string;
  conversion: Conversion;
}

// Every goal of a site at once, one conversion each, against the range's
// visitors under the filters.
export interface GoalStatsResult {
  visitors: number;
  rows: GoalStatsRow[];
  rawOnly: true;
}

export function finishEventRow(
  key: string,
  tally: { visitors: number; events: number },
  base: number,
): EventRow {
  return {
    key,
    visitors: tally.visitors,
    events: tally.events,
    rate: base === 0 ? null : tally.visitors / base,
  };
}

// Most people first, then most often, then alphabetical, so a tie never
// reorders itself between two reads or two adapters.
export function sortEventRows(rows: EventRow[]): EventRow[] {
  return rows.sort((left, right) => {
    if (right.visitors !== left.visitors) {
      return right.visitors - left.visitors;
    }
    if (right.events !== left.events) {
      return right.events - left.events;
    }
    return left.key.localeCompare(right.key);
  });
}

export function sortPropertyCounts(rows: PropertyCount[]): PropertyCount[] {
  return rows.sort((left, right) =>
    right.events !== left.events ? right.events - left.events : left.key.localeCompare(right.key),
  );
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
  status: 'status',
  bot: 'bot',
};

// Where the same dimension lives on a session row. A session is where a visit,
// a bounce and a duration come from, so every dimension a visit can be
// attributed to has to be findable here. The five that are missing are the
// five a stay spans rather than has: a visit is not one page, one screen size,
// one language, one custom event or one status.
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

// The one type of row a dimension belongs to, where it belongs to one.
//
// A name is carried by two kinds of row: a custom event, and a page timing
// v.js reports through the same queue as pa('vital', 'LCP'). An event
// dimension that read the name off both would list LCP, CLS and INP beside
// signup, and file them into every rollup of the dimension from the first day
// a site loads v.js, which is history nobody can take back. So the event
// dimension is the custom events and nothing else, a server's included,
// because what a backend sends is type event too.
export const EVENT_TYPE_BY_DIMENSION: Readonly<Partial<Record<Dimension, EventType>>> = {
  event: 'event',
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
  if (path === undefined) {
    return undefined;
  }
  const type = EVENT_TYPE_BY_DIMENSION[dim];
  if (type !== undefined && event.type !== type) {
    return undefined;
  }
  return readPath(event, path);
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
