import {
  BOT_DIMENSION,
  EVENT_PATH_BY_DIMENSION,
  EVENT_TYPE_BY_DIMENSION,
  MAX_PROPERTY_KEYS,
  SESSION_PATH_BY_DIMENSION,
  dayBounds,
  dayKeysBetween,
  goalIsPattern,
  goalPattern,
  splitVisitFilters,
  type Dimension,
  type Filter,
  type GoalMatch,
  type Range,
  type RollupDim,
} from '@chokh/store';

import { EVENTS, ROLLUPS_DAILY, SESSIONS } from './schema.js';

// Every read is one statement, and every statement is built here so the
// EXPLAIN tests can hold the same text the adapter runs.
//
// A unique visitor is a per-day fact, which is why the raw reads group by day
// and visitor first and only then add the days up: that is the arithmetic a
// daily rollup does, so a range that crosses the rollup boundary does not
// change meaning halfway through.
//
// No statement here draws a day or a bucket. The contract does (dayBounds,
// bucketsBetween, in the site's own zone), the boundaries arrive as a bigint[]
// parameter, and SQL groups by width_bucket over them. So a day is the day
// dayKey says it is on any server, whatever its time zone setting and however
// old its zone data, and the two adapters cannot disagree about a midnight.

export interface Statement {
  text: string;
  values: unknown[];
}

// The parameters of one statement, numbered as they are added.
export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

// Where a dimension lives on an event row and on a stay row: the contract's
// own maps of field paths, turned into this schema's columns. One table, so a
// dimension the contract grows without a column here fails loudly (a test
// walks every dimension) rather than reading nothing.
const COLUMN_BY_PATH: Readonly<Record<string, string>> = {
  path: 'path',
  route: 'route',
  referrer: 'referrer',
  'utm.source': 'utm_source',
  'utm.medium': 'utm_medium',
  'utm.campaign': 'utm_campaign',
  'utm.term': 'utm_term',
  'utm.content': 'utm_content',
  'geo.country': 'country',
  'geo.region': 'region',
  'geo.city': 'city',
  'ua.browser': 'browser',
  'ua.os': 'os',
  'ua.device': 'device',
  screen: 'screen',
  lang: 'lang',
  name: 'name',
  status: 'status',
  bot: 'bot',
  entryPath: 'entry_path',
  exitPath: 'exit_path',
  channel: 'channel',
};

function columnAt(path: string): string {
  const found = COLUMN_BY_PATH[path];
  if (found === undefined) {
    throw new Error(`No column holds ${path}`);
  }
  return found;
}

export function eventColumn(dim: Dimension): string | undefined {
  const path = EVENT_PATH_BY_DIMENSION[dim];
  return path === undefined ? undefined : columnAt(path);
}

export function sessionColumn(dim: Dimension): string | undefined {
  const path = SESSION_PATH_BY_DIMENSION[dim];
  return path === undefined ? undefined : columnAt(path);
}

// The value a breakdown groups an event by, or null where the row has none.
// The event dimension is the custom events and nothing else: a page timing
// carries a name too and must not be listed beside signup.
export function eventKey(dim: Dimension, alias = 'e'): string | null {
  if (dim === BOT_DIMENSION) {
    return `${alias}.bot::text`;
  }
  const found = eventColumn(dim);
  if (found === undefined) {
    return null;
  }
  const type = EVENT_TYPE_BY_DIMENSION[dim];
  return type === undefined
    ? `${alias}.${found}`
    : `CASE WHEN ${alias}.type = '${type}' THEN ${alias}.${found} END`;
}

export function sessionKey(dim: Dimension, alias = 's'): string | null {
  if (dim === BOT_DIMENSION) {
    return `${alias}.bot::text`;
  }
  const found = sessionColumn(dim);
  return found === undefined ? null : `${alias}.${found}`;
}

// One filter as a condition on a column.
//
// is_not has to be true of a row with no value at all, which <> is not (it is
// null there, and null is not true), so it is IS DISTINCT FROM. contains is a
// piece of text and never a pattern: strpos, not LIKE, so a percent sign typed
// into a filter means a percent sign.
function condition(column: string, filter: Filter, params: Params): string {
  const value = params.add(filter.value);
  if (filter.op === 'is') {
    return `${column} = ${value}`;
  }
  if (filter.op === 'is_not') {
    return `${column} IS DISTINCT FROM ${value}`;
  }
  return `strpos(${column}, ${value}) > 0`;
}

export interface Span {
  site: string;
  from: string;
  to: string;
}

export function spanOf(siteId: string, span: Range, params: Params): Span {
  return { site: params.add(siteId), from: params.add(span.from), to: params.add(span.to) };
}

// The site, the span and the bot side of the line, plus whatever the query
// filtered on that a row carries. A bot filter is already answered by the bot
// column itself, so it never becomes a second condition.
//
// A filter only a stay carries (where it came in, where it went out, the
// channel) is answered by a semi-join: the rows whose stay is one of the stays
// that overlap the span and match. The overlap is the window, so a row at ten
// past midnight is in the stay that began before it, whichever day that was.
// A row written before stays were stamped has no stay and is out of the
// report, the rule every adapter keeps.
export function eventWhere(
  at: Span,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  params: Params,
  alias = 'e',
): string {
  const parts = [
    `${alias}.site_id = ${at.site}`,
    `${alias}.ts >= ${at.from}`,
    `${alias}.ts < ${at.to}`,
    `${alias}.bot = ${params.add(wantsBots)}`,
  ];
  const split = splitVisitFilters(filters);
  for (const filter of split.event) {
    const found = eventColumn(filter.dim);
    if (found === undefined) {
      // Not reachable: every dimension a row carries is on this side of the
      // split. Matching nothing is the belt to that pair of braces.
      return 'FALSE';
    }
    const column = `${alias}.${found}`;
    const type = EVENT_TYPE_BY_DIMENSION[filter.dim];
    if (type === undefined) {
      parts.push(condition(column, filter, params));
    } else if (filter.op === 'is_not') {
      // A row of another type has no value here, and "not signup" is true of it.
      parts.push(`(${alias}.type <> '${type}' OR ${condition(column, filter, params)})`);
    } else {
      parts.push(`${alias}.type = '${type}'`, condition(column, filter, params));
    }
  }
  if (split.stay.length > 0) {
    const stay = [
      `stay.site_id = ${at.site}`,
      `stay.started_at < ${at.to}`,
      `stay.last_seen_at >= ${at.from}`,
    ];
    for (const filter of split.stay) {
      const found = sessionColumn(filter.dim);
      if (found !== undefined) {
        stay.push(condition(`stay.${found}`, filter, params));
      }
    }
    parts.push(
      `${alias}.session_id IN (SELECT stay.id FROM ${SESSIONS} stay WHERE ${stay.join(' AND ')})`,
    );
  }
  return parts.join(' AND ');
}

// A visit belongs to the day the stay began on, so every read of the session
// side cuts by started_at and never by last_seen_at: a stay that crosses
// midnight is one visit, on the day it started.
export function sessionWhere(
  at: Span,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  params: Params,
): string {
  const parts = [
    `s.site_id = ${at.site}`,
    `s.started_at >= ${at.from}`,
    `s.started_at < ${at.to}`,
    `s.bot = ${params.add(wantsBots)}`,
  ];
  for (const filter of filters ?? []) {
    if (filter.dim === BOT_DIMENSION) {
      continue;
    }
    const found = sessionColumn(filter.dim);
    if (found === undefined) {
      // A stay spans pages, screens, languages and events rather than having
      // one of each, so it cannot answer a filter on those. The adapter checks
      // for this before it asks, and this is the belt to that pair of braces.
      return 'FALSE';
    }
    parts.push(condition(`s.${found}`, filter, params));
  }
  return parts.join(' AND ');
}

// The start of every day of the site's calendar the span touches, drawn by the
// contract. width_bucket over them numbers the days from one.
export function dayStarts(span: Range, timezone: string): number[] {
  const starts = dayKeysBetween(span.from, span.to, timezone).map(
    (key) => dayBounds(key, timezone).start,
  );
  return starts.length === 0 ? [span.from] : starts;
}

const IS_PAGEVIEW = `count(*) FILTER (WHERE e.type = 'pageview')`;
// One page and away, the rule isBounce states for the other adapters.
const SESSION_SUMS = `count(*) AS visits,
       count(*) FILTER (WHERE s.pageviews <= 1) AS bounces,
       coalesce(sum(s.duration), 0)::bigint AS "durationSum"`;

// Totals for a span of raw rows: distinct visitors per day, added up, and
// every pageview in the span.
export function rawTotalsSql(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const where = eventWhere(at, wantsBots, filters, params);
  const days = params.add(dayStarts(span, timezone));
  return {
    text: `
SELECT coalesce(sum(day.visitors), 0)::bigint AS visitors,
       coalesce(sum(day.pageviews), 0)::bigint AS pageviews
  FROM (
    SELECT seen.day, count(*) AS visitors, sum(seen.pageviews) AS pageviews
      FROM (
        SELECT width_bucket(e.ts, ${days}::bigint[]) AS day, e.visitor_id, ${IS_PAGEVIEW} AS pageviews
          FROM ${EVENTS} e
         WHERE ${where}
         GROUP BY 1, 2
      ) seen
     GROUP BY seen.day
  ) day`,
    values: params.values,
  };
}

function keyList(dims: readonly Dimension[], pick: (dim: Dimension) => string | null): string {
  const rows: string[] = [];
  for (const dim of dims) {
    const key = pick(dim);
    if (key !== null) {
      rows.push(`('${dim}', ${key})`);
    }
  }
  return rows.join(', ');
}

// The same, one row per value of a dimension, for one dimension or for many.
// A breakdown asks for one; a rollup asks for every rolled dimension in one
// pass of the day's rows, so a rolled day is what a raw read of it answers by
// construction.
export function rawBreakdownSql(
  siteId: string,
  span: Range,
  timezone: string,
  dims: readonly Dimension[],
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const where = eventWhere(at, wantsBots, filters, params);
  const days = params.add(dayStarts(span, timezone));
  return {
    text: `
SELECT day.dim, day.key,
       sum(day.visitors)::bigint AS visitors, sum(day.pageviews)::bigint AS pageviews
  FROM (
    SELECT seen.dim, seen.key, seen.day, count(*) AS visitors, sum(seen.pageviews) AS pageviews
      FROM (
        SELECT keyed.dim, keyed.key, width_bucket(e.ts, ${days}::bigint[]) AS day, e.visitor_id,
               ${IS_PAGEVIEW} AS pageviews
          FROM ${EVENTS} e
         CROSS JOIN LATERAL (VALUES ${keyList(dims, (dim) => eventKey(dim))}) AS keyed(dim, key)
         WHERE ${where} AND keyed.key IS NOT NULL
         GROUP BY 1, 2, 3, 4
      ) seen
     GROUP BY 1, 2, 3
  ) day
 GROUP BY 1, 2`,
    values: params.values,
  };
}

const ROLLUP_SUMS = `sum(visitors)::bigint AS visitors, sum(pageviews)::bigint AS pageviews,
       sum(visits)::bigint AS visits, sum(bounces)::bigint AS bounces,
       sum(duration_sum)::bigint AS "durationSum"`;

export function rollupTotalsSql(
  siteId: string,
  days: string[],
  dim: RollupDim,
  key: string,
): Statement {
  return {
    text: `
SELECT ${ROLLUP_SUMS}
  FROM ${ROLLUPS_DAILY}
 WHERE site_id = $1 AND date = ANY($2::date[]) AND dim = $3 AND key = $4`,
    values: [siteId, days, dim, key],
  };
}

export function rollupBreakdownSql(siteId: string, days: string[], dim: Dimension): Statement {
  return {
    text: `
SELECT key, ${ROLLUP_SUMS}
  FROM ${ROLLUPS_DAILY}
 WHERE site_id = $1 AND dim = $2 AND date = ANY($3::date[])
 GROUP BY key`,
    values: [siteId, dim, days],
  };
}

// The same per day, out of the daily rollups, which already hold one row a day.
export function rollupTotalsByDateSql(
  siteId: string,
  days: string[],
  dim: RollupDim,
  key: string,
): Statement {
  return {
    text: `
SELECT date::text AS date, ${ROLLUP_SUMS}
  FROM ${ROLLUPS_DAILY}
 WHERE site_id = $1 AND date = ANY($2::date[]) AND dim = $3 AND key = $4
 GROUP BY date`,
    values: [siteId, days, dim, key],
  };
}

// Visits, bounces and time, for a span. Visitors and pageviews are not here:
// those come from events, which is the one place they are counted.
export function sessionTotalsSql(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const where = sessionWhere(spanOf(siteId, span, params), wantsBots, filters, params);
  return {
    text: `
SELECT ${SESSION_SUMS}
  FROM ${SESSIONS} s
 WHERE ${where}`,
    values: params.values,
  };
}

// The same, one row per value of a dimension the session row carries.
export function sessionBreakdownSql(
  siteId: string,
  span: Range,
  dims: readonly Dimension[],
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const where = sessionWhere(spanOf(siteId, span, params), wantsBots, filters, params);
  return {
    text: `
SELECT keyed.dim, keyed.key, ${SESSION_SUMS}
  FROM ${SESSIONS} s
 CROSS JOIN LATERAL (VALUES ${keyList(dims, (dim) => sessionKey(dim))}) AS keyed(dim, key)
 WHERE ${where} AND keyed.key IS NOT NULL
 GROUP BY 1, 2`,
    values: params.values,
  };
}

// Entry, exit and channel: nothing on an event carries them, so visitors and
// pageviews are counted off the stays as well. Visitors stay a per-day fact,
// the way they are everywhere else.
export function sessionSourcedBreakdownSql(
  siteId: string,
  span: Range,
  timezone: string,
  dims: readonly Dimension[],
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const where = sessionWhere(spanOf(siteId, span, params), wantsBots, filters, params);
  const days = params.add(dayStarts(span, timezone));
  return {
    text: `
SELECT day.dim, day.key,
       sum(day.visitors)::bigint AS visitors, sum(day.pageviews)::bigint AS pageviews,
       sum(day.visits)::bigint AS visits, sum(day.bounces)::bigint AS bounces,
       sum(day.duration_sum)::bigint AS "durationSum"
  FROM (
    SELECT seen.dim, seen.key, seen.day, count(*) AS visitors, sum(seen.pageviews) AS pageviews,
           sum(seen.visits) AS visits, sum(seen.bounces) AS bounces,
           sum(seen.duration_sum) AS duration_sum
      FROM (
        SELECT keyed.dim, keyed.key, width_bucket(s.started_at, ${days}::bigint[]) AS day, s.visitor_id,
               sum(s.pageviews) AS pageviews, count(*) AS visits,
               count(*) FILTER (WHERE s.pageviews <= 1) AS bounces,
               sum(s.duration) AS duration_sum
          FROM ${SESSIONS} s
         CROSS JOIN LATERAL (VALUES ${keyList(dims, (dim) => sessionKey(dim))}) AS keyed(dim, key)
         WHERE ${where} AND keyed.key IS NOT NULL
         GROUP BY 1, 2, 3, 4
      ) seen
     GROUP BY 1, 2, 3
  ) day
 GROUP BY 1, 2`,
    values: params.values,
  };
}

// A whole time series in one round trip: the rows grouped by the bucket they
// fall in, answered under the instant that bucket begins, so the caller never
// draws a boundary a second time. `starts` is the contract's own list: the
// days of the span for a day or coarser (the caller folds each day into its
// week or month), the hours or the minutes for a finer one. A visitor is
// distinct within one of those.
export function rawTotalsByBucketSql(
  siteId: string,
  span: Range,
  starts: readonly number[],
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const where = eventWhere(at, wantsBots, filters, params);
  const buckets = params.add([...starts]);
  return {
    text: `
SELECT (${buckets}::bigint[])[seen.bucket] AS start,
       count(*) AS visitors, sum(seen.pageviews)::bigint AS pageviews
  FROM (
    SELECT width_bucket(e.ts, ${buckets}::bigint[]) AS bucket, e.visitor_id, ${IS_PAGEVIEW} AS pageviews
      FROM ${EVENTS} e
     WHERE ${where}
     GROUP BY 1, 2
  ) seen
 WHERE seen.bucket >= 1
 GROUP BY seen.bucket`,
    values: params.values,
  };
}

// Visits, bounces and time per bucket. A visit belongs to the bucket its stay
// began in.
export function sessionTotalsByBucketSql(
  siteId: string,
  span: Range,
  starts: readonly number[],
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const where = sessionWhere(spanOf(siteId, span, params), wantsBots, filters, params);
  const buckets = params.add([...starts]);
  return {
    text: `
SELECT (${buckets}::bigint[])[seen.bucket] AS start, seen.visits, seen.bounces, seen."durationSum"
  FROM (
    SELECT width_bucket(s.started_at, ${buckets}::bigint[]) AS bucket, ${SESSION_SUMS}
      FROM ${SESSIONS} s
     WHERE ${where}
     GROUP BY 1
  ) seen
 WHERE seen.bucket >= 1`,
    values: params.values,
  };
}

// Time on page and scroll depth per value of one dimension, from the leave
// beacons of a span. The two counts are separate sums because a leave can
// carry a duration, a depth, both or neither, and a missing one must not be
// averaged in as a zero: count(column) passes over a null.
export function engagementSql(
  siteId: string,
  span: Range,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const where = eventWhere(spanOf(siteId, span, params), wantsBots, filters, params);
  return {
    text: `
SELECT ${eventKey(dim) ?? 'NULL'} AS key,
       coalesce(sum(e.duration), 0) AS "durationSum", count(e.duration) AS "durationCount",
       coalesce(sum(e.scroll_depth), 0) AS "scrollSum", count(e.scroll_depth) AS "scrollCount",
       count(*) AS leaves
  FROM ${EVENTS} e
 WHERE ${where} AND e.type = 'leave'
 GROUP BY 1`,
    values: params.values,
  };
}

// Conversions. A conversion is an overlap of two sets of people per day, the
// people a read counted and the people who reached the goal, so each statement
// below gathers both halves under the same (day, visitor) key and joins them.
// Both halves open on the site and the range, so both lead with an index.

// Whether a row reaches a goal. A page goal is reached by a pageview of a
// matching path and by nothing else; a star is one segment of the path, and
// the pattern is the very string the contract builds for the other adapters.
export function goalReached(goal: GoalMatch, params: Params, alias: string): string {
  if (goal.kind === 'event') {
    return `${alias}.type = 'event' AND ${alias}.name = ${params.add(goal.match)}`;
  }
  if (!goalIsPattern(goal)) {
    return `${alias}.type = 'pageview' AND ${alias}.path = ${params.add(goal.match)}`;
  }
  return `${alias}.type = 'pageview' AND ${alias}.path ~ ${params.add(goalPattern(goal.match))}`;
}

// The rows that reach a goal: the site, the span, the bot side and the goal,
// and none of the query's other filters. Those narrow the people a conversion
// is counted against, never the goal.
export function goalWhere(at: Span, wantsBots: boolean, goal: GoalMatch, params: Params): string {
  return [
    `g.site_id = ${at.site}`,
    `g.ts >= ${at.from}`,
    `g.ts < ${at.to}`,
    `g.bot = ${params.add(wantsBots)}`,
    goalReached(goal, params, 'g'),
  ].join(' AND ');
}

// Converted visitors and completions for a whole read, against the people its
// own events counted.
export function conversionTotalsSql(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  goal: GoalMatch,
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const where = eventWhere(at, wantsBots, filters, params);
  const reached = goalWhere(at, wantsBots, goal, params);
  const days = params.add(dayStarts(span, timezone));
  return {
    text: `
WITH counted AS (
  SELECT DISTINCT width_bucket(e.ts, ${days}::bigint[]) AS day, e.visitor_id
    FROM ${EVENTS} e
   WHERE ${where}
), converted AS (
  SELECT width_bucket(g.ts, ${days}::bigint[]) AS day, g.visitor_id, count(*) AS completions
    FROM ${EVENTS} g
   WHERE ${reached}
   GROUP BY 1, 2
)
SELECT count(*) AS visitors, coalesce(sum(converted.completions), 0)::bigint AS completions
  FROM counted JOIN converted USING (day, visitor_id)`,
    values: params.values,
  };
}

// Converted visitors per value of a dimension an event carries, counted
// against the events that put each visitor in each row.
export function conversionBreakdownSql(
  siteId: string,
  span: Range,
  timezone: string,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  goal: GoalMatch,
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const where = eventWhere(at, wantsBots, filters, params);
  const reached = goalWhere(at, wantsBots, goal, params);
  const days = params.add(dayStarts(span, timezone));
  const key = eventKey(dim) ?? 'NULL';
  return {
    text: `
WITH member AS (
  SELECT DISTINCT width_bucket(e.ts, ${days}::bigint[]) AS day, e.visitor_id, ${key} AS key
    FROM ${EVENTS} e
   WHERE ${where} AND ${key} IS NOT NULL
), converted AS (
  SELECT width_bucket(g.ts, ${days}::bigint[]) AS day, g.visitor_id, count(*) AS completions
    FROM ${EVENTS} g
   WHERE ${reached}
   GROUP BY 1, 2
)
SELECT member.key, count(*) AS visitors, sum(converted.completions)::bigint AS completions
  FROM member JOIN converted USING (day, visitor_id)
 GROUP BY member.key`,
    values: params.values,
  };
}

// The same for entry, exit and channel, whose visitors are counted off the
// stays: a visitor is in a row on the day a stay of theirs with that value
// began, the rule the breakdown already counts them by.
export function sessionConversionBreakdownSql(
  siteId: string,
  span: Range,
  timezone: string,
  dim: Dimension,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  goal: GoalMatch,
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const where = sessionWhere(at, wantsBots, filters, params);
  const reached = goalWhere(at, wantsBots, goal, params);
  const days = params.add(dayStarts(span, timezone));
  const key = sessionKey(dim) ?? 'NULL';
  return {
    text: `
WITH member AS (
  SELECT DISTINCT width_bucket(s.started_at, ${days}::bigint[]) AS day, s.visitor_id, ${key} AS key
    FROM ${SESSIONS} s
   WHERE ${where} AND ${key} IS NOT NULL
), converted AS (
  SELECT width_bucket(g.ts, ${days}::bigint[]) AS day, g.visitor_id, count(*) AS completions
    FROM ${EVENTS} g
   WHERE ${reached}
   GROUP BY 1, 2
)
SELECT member.key, count(*) AS visitors, sum(converted.completions)::bigint AS completions
  FROM member JOIN converted USING (day, visitor_id)
 GROUP BY member.key`,
    values: params.values,
  };
}

// Every goal's converted visitors and completions in one round trip, against
// the people the read's own events counted. One pass of the range tags each
// row with every goal it reaches (a pattern goal and an exact goal can both be
// reached by the same pageview), one FILTER per goal, and the answer is one
// row: v0, n0, v1, n1 and so on in the order the goals were handed in.
export function goalStatsSql(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  goals: readonly GoalMatch[],
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const where = eventWhere(at, wantsBots, filters, params);
  const bots = params.add(wantsBots);
  const reached = goals.map((goal) => goalReached(goal, params, 'g'));
  const days = params.add(dayStarts(span, timezone));
  return {
    text: `
WITH counted AS (
  SELECT DISTINCT width_bucket(e.ts, ${days}::bigint[]) AS day, e.visitor_id
    FROM ${EVENTS} e
   WHERE ${where}
), reached AS (
  SELECT width_bucket(g.ts, ${days}::bigint[]) AS day, g.visitor_id,
         ${reached.map((each, index) => `count(*) FILTER (WHERE ${each}) AS n${index}`).join(',\n         ')}
    FROM ${EVENTS} g
   WHERE g.site_id = ${at.site} AND g.ts >= ${at.from} AND g.ts < ${at.to} AND g.bot = ${bots}
     AND (${reached.map((each) => `(${each})`).join(' OR ')})
   GROUP BY 1, 2
)
SELECT ${goals
      .map(
        (_, index) =>
          `count(*) FILTER (WHERE reached.n${index} > 0) AS v${index}, coalesce(sum(reached.n${index}), 0)::bigint AS n${index}`,
      )
      .join(',\n       ')}
  FROM counted JOIN reached USING (day, visitor_id)`,
    values: params.values,
  };
}

// The events report and the property breakdown. Custom events only, by type,
// so a page timing never reaches either.

// Visitors, each day's added up, and how many times, per event name.
export function eventsSql(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
): Statement {
  const params = new Params();
  const where = eventWhere(spanOf(siteId, span, params), wantsBots, filters, params);
  const days = params.add(dayStarts(span, timezone));
  return {
    text: `
SELECT day.key, sum(day.visitors)::bigint AS visitors, sum(day.events)::bigint AS events
  FROM (
    SELECT seen.key, seen.day, count(*) AS visitors, sum(seen.events) AS events
      FROM (
        SELECT e.name AS key, width_bucket(e.ts, ${days}::bigint[]) AS day, e.visitor_id,
               count(*) AS events
          FROM ${EVENTS} e
         WHERE ${where} AND e.type = 'event' AND e.name IS NOT NULL
         GROUP BY 1, 2, 3
      ) seen
     GROUP BY 1, 2
  ) day
 GROUP BY 1`,
    values: params.values,
  };
}

// A row's properties as an object, whatever was stored: nothing else has keys.
const PROPS = `CASE WHEN jsonb_typeof(e.props) = 'object' THEN e.props ELSE '{}'::jsonb END`;

// The property names one event carried, most used first, the tie by bytes.
export function propertyKeysSql(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  event: string,
): Statement {
  const params = new Params();
  const where = eventWhere(spanOf(siteId, span, params), wantsBots, filters, params);
  const name = params.add(event);
  return {
    text: `
SELECT property.key, count(*) AS events
  FROM ${EVENTS} e
 CROSS JOIN LATERAL jsonb_object_keys(${PROPS}) AS property(key)
 WHERE ${where} AND e.type = 'event' AND e.name = ${name}
 GROUP BY property.key
 ORDER BY events DESC, property.key COLLATE "C"
 LIMIT ${MAX_PROPERTY_KEYS}`,
    values: params.values,
  };
}

// One event broken down by one property. The name is a parameter of ->>, never
// part of a path, so a property is whatever a page passed: a name with a dot
// in it is that name, by construction. An event that did not carry it is the
// '' row.
export function propertyValuesSql(
  siteId: string,
  span: Range,
  timezone: string,
  wantsBots: boolean,
  filters: Filter[] | undefined,
  event: string,
  property: string,
): Statement {
  const params = new Params();
  const where = eventWhere(spanOf(siteId, span, params), wantsBots, filters, params);
  const name = params.add(event);
  const field = params.add(property);
  const days = params.add(dayStarts(span, timezone));
  return {
    text: `
SELECT day.key, sum(day.visitors)::bigint AS visitors, sum(day.events)::bigint AS events
  FROM (
    SELECT seen.key, seen.day, count(*) AS visitors, sum(seen.events) AS events
      FROM (
        SELECT coalesce(${PROPS} ->> ${field}, '') AS key,
               width_bucket(e.ts, ${days}::bigint[]) AS day, e.visitor_id, count(*) AS events
          FROM ${EVENTS} e
         WHERE ${where} AND e.type = 'event' AND e.name = ${name}
         GROUP BY 1, 2, 3
      ) seen
     GROUP BY 1, 2
  ) day
 GROUP BY 1`,
    values: params.values,
  };
}
