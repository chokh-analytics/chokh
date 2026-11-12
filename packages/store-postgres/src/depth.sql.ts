import {
  ERROR_FACET_LIMIT,
  JOURNEY_ROWS_PER_VISIT,
  JOURNEY_STEPS,
  MAX_FUNNEL_ROWS_PER_VISITOR,
  MAX_FUNNEL_STEPS,
  MIN_FUNNEL_STEPS,
  VITAL_METRICS,
  VITAL_SCALES,
  type Filter,
  type FunnelRead,
  type GoalMatch,
  type Range,
} from '@chokh/store';

import {
  Params,
  eventWhere,
  goalReached,
  goalWhere,
  sessionWhere,
  spanOf,
  type Statement,
} from './reads.sql.js';
import { EVENTS, SESSIONS, VISITORS } from './schema.js';
import { VISITOR_COLUMNS } from './rows.js';

// A whole number in a range, for the few numbers written into a statement
// rather than bound to it: how many steps a fold has, how wide a window is.
// They come from the contract's own constants and from a list's length, and
// are checked here anyway, because a number that is not one is text.
function whole(value: number, least: number, most: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < least || value > most) {
    throw new Error(`${what} is not a whole number between ${least} and ${most}`);
  }
  return value;
}

// A name of a relation a fold reads, and a placeholder it compares with. Both
// are written by this package's own callers and its tests, never by a query,
// and are held to their shape for the reason the numbers are.
function relation(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error('A fold reads a relation by a plain name');
  }
  return name;
}

function placeholder(text: string, type: 'bigint' | 'int'): string {
  if (!new RegExp(`^\\$[1-9][0-9]*::${type}$`).test(text)) {
    throw new Error(`A fold compares with a numbered ${type} parameter`);
  }
  return text;
}

// The reads that follow people rather than count rows: funnels, journeys,
// retention and health. Each folds inside the database, so what crosses the
// wire is a handful of depths, a grid, a few hundred counts or one page of
// people, and never a row per visitor. The rules they fold by live in
// @chokh/store (funnel.ts, journey.ts, retention.ts, health.ts), where the
// in-memory adapter runs them in JS; the conformance suite holds the two to
// one answer, and this package's own tests hold the two folds written in SQL
// (the funnel and the activity windows) to the shared ones on seeded rows.

// ---------------------------------------------------------------- funnels

// The fold of funnel.ts over step rows, as SQL. `source` is a relation of
// (visitor_id, session_id, ts, h0 .. hN-1): one row per event that reaches at
// least one step, with which steps it reaches.
//
// funnelDepth keeps, for every step, the latest start of any chain that has
// reached it, and updates every step from the state before the row. That
// state only ever grows, so each step is a running maximum: a row reaching
// step k hands on the start it finds at step k - 1 (as it stood before the
// row) when the row is inside that start's window. So the whole fold is one
// window pass per step, each over the same partition in the same order, and
// the depth is how many steps ended with a start at all.
//
// Rows are folded in funnel order (the time, then the lowest step reached,
// then every step reached as one number), the first MAX_FUNNEL_ROWS_PER_VISITOR
// of each visitor only, and by visit when the window is one visit: one fold
// per stay, the deepest kept.
export function funnelFoldSql(
  from: string,
  count: number,
  within: string,
  byVisit: boolean,
): string {
  const source = relation(from);
  const steps = whole(count, MIN_FUNNEL_STEPS, MAX_FUNNEL_STEPS, 'The number of steps');
  const window = placeholder(within, 'bigint');
  const indexes = Array.from({ length: steps }, (_, index) => index);
  const first = `CASE ${indexes.map((index) => `WHEN h${index} THEN ${index}`).join(' ')} ELSE ${steps} END`;
  const mask = indexes.map((index) => `(h${index}::int * ${2 ** index})`).join(' + ');
  const partition = byVisit ? 'visitor_id, session_id' : 'visitor_id';
  const before = `(PARTITION BY ${partition} ORDER BY ts, first, mask ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`;

  const levels: string[] = [`level0 AS (SELECT *, CASE WHEN h0 THEN ts END AS c0 FROM capped)`];
  for (const index of indexes.slice(1)) {
    const previous = index - 1;
    levels.push(
      `level${index} AS (
    SELECT *, CASE WHEN h${index} AND p${previous} IS NOT NULL AND ts - p${previous} <= ${window}
                   THEN p${previous} END AS c${index}
      FROM (SELECT *, max(c${previous}) OVER ${before} AS p${previous} FROM level${previous}) carried)`,
    );
  }
  const reached = indexes.map((index) => `(max(c${index}) IS NOT NULL)::int`).join(' + ');
  return `ordered AS (
    SELECT *, row_number() OVER (PARTITION BY visitor_id ORDER BY ts, first, mask) AS place
      FROM (SELECT ${source}.*, ${first} AS first, ${mask} AS mask FROM ${source}) marked),
  capped AS (SELECT * FROM ordered WHERE place <= ${MAX_FUNNEL_ROWS_PER_VISITOR}),
  ${levels.join(',\n  ')},
  depth AS (
    SELECT visitor_id, max(reached) AS depth
      FROM (SELECT ${partition}, ${reached} AS reached FROM level${steps - 1} GROUP BY ${partition}) folded
     GROUP BY visitor_id)`;
}

// How far the people of the range got. One statement: who is in the segment
// (by their rows, and by their stays when a filter names something only a
// stay carries), how deep each visitor got, and the two met per visitor. At
// most steps + 1 rows come back whatever the traffic.
export function funnelSql(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: { event: Filter[]; stay: Filter[] },
  funnel: FunnelRead,
  windowMs: number,
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const member = eventWhere(at, wantsBots, filters.event, params);
  const staying =
    filters.stay.length === 0 ? null : sessionWhere(at, wantsBots, filters.stay, params);
  const bots = params.add(wantsBots);
  const reached = funnel.steps.map((step) => goalReached(step, params, 'g'));
  const byVisit = funnel.window === 'visit';
  const window = `${params.add(windowMs)}::bigint`;
  return {
    text: `
WITH member AS (
    SELECT DISTINCT e.visitor_id FROM ${EVENTS} e WHERE ${member}),
  ${staying === null ? '' : `staying AS (SELECT DISTINCT s.visitor_id FROM ${SESSIONS} s WHERE ${staying}),`}
  hits AS (
    SELECT g.visitor_id, g.session_id, g.ts,
           ${reached.map((each, index) => `coalesce(${each}, FALSE) AS h${index}`).join(',\n           ')}
      FROM ${EVENTS} g
     WHERE g.site_id = ${at.site} AND g.ts >= ${at.from} AND g.ts < ${at.to} AND g.bot = ${bots}
       AND (${reached.map((each) => `(${each})`).join(' OR ')})
       ${byVisit ? 'AND g.session_id IS NOT NULL' : ''}),
  ${funnelFoldSql('hits', funnel.steps.length, window, byVisit)}
SELECT coalesce(depth.depth, 0) AS depth, count(*) AS visitors
  FROM member
  ${staying === null ? '' : 'JOIN staying USING (visitor_id)'}
  LEFT JOIN depth USING (visitor_id)
 GROUP BY 1`,
    values: params.values,
  };
}

// ---------------------------------------------------------------- journeys

// The paths the range's visits took, folded onto each column's most visited
// pages and counted, in one statement: a visit's first JOURNEY_ROWS_PER_VISIT
// pageviews in time order, a page repeated back to back counted once, cut to
// JOURNEY_STEPS; each column's top pages chosen over every visit that reached
// it (most visited first, the tie by bytes); and every visit's steps counted
// by the node they landed on and where they went next.
//
// A visit is in the report by its stay, and a filter a row carries narrows the
// visits and never the path: the visit is in when a row of it in the range
// matches. The answer is at most a few hundred rows whatever the traffic.
export function journeysSql(
  siteId: string,
  span: Range,
  wantsBots: boolean,
  filters: { event: Filter[]; stay: Filter[] },
  branches: number,
): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const visit = sessionWhere(at, wantsBots, filters.stay, params);
  const matched =
    filters.event.length === 0 ? null : eventWhere(at, wantsBots, filters.event, params);
  const bots = params.add(wantsBots);
  const keep = params.add(branches);
  const last = JOURNEY_STEPS - 1;
  return {
    text: `
WITH visit AS (
    SELECT s.id FROM ${SESSIONS} s
     WHERE ${visit}
       ${matched === null ? '' : `AND s.id IN (SELECT e.session_id FROM ${EVENTS} e WHERE ${matched})`}),
  viewed AS (
    SELECT g.session_id, coalesce(g.path, '') AS path,
           row_number() OVER (PARTITION BY g.session_id
                              ORDER BY g.ts, coalesce(g.path, '') COLLATE "C") AS place
      FROM ${EVENTS} g
     WHERE g.site_id = ${at.site} AND g.ts >= ${at.from} AND g.ts < ${at.to} AND g.bot = ${bots}
       AND g.type = 'pageview' AND g.session_id IS NOT NULL),
  turned AS (
    SELECT session_id, path, place
      FROM (SELECT session_id, path, place,
                   lag(path) OVER (PARTITION BY session_id ORDER BY place) AS before
              FROM viewed WHERE place <= ${JOURNEY_ROWS_PER_VISIT}) paged
     WHERE before IS DISTINCT FROM path),
  step AS (
    SELECT turned.session_id, turned.path,
           row_number() OVER (PARTITION BY turned.session_id ORDER BY turned.place) - 1 AS col,
           count(*) OVER (PARTITION BY turned.session_id) AS length
      FROM turned JOIN visit ON visit.id = turned.session_id),
  top AS (
    SELECT col, path
      FROM (SELECT col, path,
                   row_number() OVER (PARTITION BY col
                                      ORDER BY count(*) DESC, path COLLATE "C") AS place
              FROM step WHERE col <= ${last} GROUP BY col, path) ranked
     WHERE place <= ${keep}),
  keyed AS (
    SELECT step.session_id, step.col, step.length,
           CASE WHEN top.path IS NULL THEN NULL ELSE step.path END AS node
      FROM step LEFT JOIN top ON top.col = step.col AND top.path = step.path
     WHERE step.col <= ${last}),
  linked AS (
    SELECT col, node, length,
           lead(node) OVER (PARTITION BY session_id ORDER BY col) AS after,
           col + 1 < least(length, ${JOURNEY_STEPS}) AS goes_on
      FROM keyed)
SELECT col, node, CASE WHEN goes_on THEN after END AS after,
       CASE WHEN goes_on THEN 'next'
            WHEN col = ${last} AND length > ${JOURNEY_STEPS} THEN 'onward'
            ELSE 'exit' END AS ending,
       count(*) AS visits
  FROM linked
 GROUP BY 1, 2, 3, 4`,
    values: params.values,
  };
}

// ---------------------------------------------------------------- retention

// Every read below starts with one walk of (site_id, started_at) over the
// stays of people, never of crawlers, and numbers each stay's bucket or day
// with the boundaries the contract drew.
function humanStays(siteId: string, span: Range, params: Params): string {
  return `s.site_id = ${params.add(siteId)} AND s.started_at >= ${params.add(span.from)} AND s.started_at < ${params.add(span.to)} AND s.bot = FALSE`;
}

// (cohort, bucket, visitors): per visitor the buckets they began a stay in
// and the earliest bucket of a stay marked new, counted per pair. Buckets are
// numbered from zero in the order of `starts`. At most one row per cell of
// the grid.
export function cohortSql(siteId: string, span: Range, starts: readonly number[]): Statement {
  const params = new Params();
  const where = humanStays(siteId, span, params);
  const buckets = params.add([...starts]);
  return {
    text: `
WITH seen AS (
    SELECT s.visitor_id, width_bucket(s.started_at, ${buckets}::bigint[]) - 1 AS bucket,
           bool_or(s.is_new) AS fresh
      FROM ${SESSIONS} s
     WHERE ${where}
     GROUP BY 1, 2),
  began AS (
    SELECT visitor_id, min(bucket) FILTER (WHERE fresh) AS cohort FROM seen GROUP BY 1)
SELECT began.cohort, seen.bucket, count(*) AS visitors
  FROM seen JOIN began USING (visitor_id)
 WHERE began.cohort IS NOT NULL AND seen.bucket >= began.cohort
 GROUP BY 1, 2`,
    values: params.values,
  };
}

// The span days each visitor began a stay on, one row per visitor and day,
// with whether a stay of that day was their first. `source` reads it; the
// activity fold below is written over that relation so a test can run exactly
// the fold over seeded visitors.
export function activityFoldSql(
  from: string,
  first: string,
  days: readonly number[],
): string {
  const source = relation(from);
  const offset = placeholder(first, 'int');
  const widths = days.map((width) => whole(width, 1, 366, 'A window'));
  // windowIntervals of retention.ts by gaps and islands: a visitor counts in
  // a window of w days on every day from one of theirs to w - 1 days after
  // it, so consecutive days no more than w apart are one run from its first
  // day to its last plus w - 1. Each run is written as +1 where it begins and
  // -1 the day after it ends, the deltas are summed per day, and the running
  // total of those is how many people the window holds that day.
  const runs = widths
    .map(
      (width) => `
    SELECT ${width} AS width, min(day) AS began, max(day) + ${width - 1} AS ended
      FROM (SELECT visitor_id, day,
                   sum(CASE WHEN gap IS NULL OR gap > ${width} THEN 1 ELSE 0 END)
                     OVER (PARTITION BY visitor_id ORDER BY day) AS run
              FROM (SELECT visitor_id, day,
                           day - lag(day) OVER (PARTITION BY visitor_id ORDER BY day) AS gap
                      FROM ${source}) stepped) grouped
     GROUP BY visitor_id, run`,
    )
    .join('\n    UNION ALL');
  return `runs AS (${runs}),
  moved AS (
    SELECT width, day, sum(by)::bigint AS by
      FROM (SELECT width, began AS day, 1 AS by FROM runs
            UNION ALL SELECT width, ended + 1, -1 FROM runs) deltas
     GROUP BY 1, 2),
  held AS (
    SELECT width, day, sum(by) OVER (PARTITION BY width ORDER BY day)::bigint AS people FROM moved),
  person AS (
    SELECT visitor_id, count(*) FILTER (WHERE day >= ${offset}) AS active,
           max(day) AS latest, min(day) FILTER (WHERE fresh) AS first
      FROM ${source} GROUP BY 1)
SELECT 'window' AS kind, width AS a, day AS b, people AS c FROM held
UNION ALL
SELECT 'curve', active, count(*), count(*) FILTER (WHERE first IS NULL OR latest > first)
  FROM person WHERE active > 0 GROUP BY active`;
}

// DAU, WAU and MAU where they change, the power curve and the returning: one
// walk of the span's stays (the range and the month before it), then the fold.
// A 'window' row says how many people window `a` holds from span day `b` on,
// until its next row; a 'curve' row says `b` visitors were active on exactly
// `a` days of the range, `c` of them returning.
export function activitySql(
  siteId: string,
  span: Range,
  starts: readonly number[],
  offset: number,
  widths: readonly number[],
): Statement {
  const params = new Params();
  const where = humanStays(siteId, span, params);
  const days = params.add([...starts]);
  const from = params.add(offset);
  return {
    text: `
WITH seen AS (
    SELECT s.visitor_id, width_bucket(s.started_at, ${days}::bigint[]) - 1 AS day,
           bool_or(s.is_new) AS fresh
      FROM ${SESSIONS} s
     WHERE ${where}
     GROUP BY 1, 2),
  ${activityFoldSql('seen', `${from}::int`, widths)}`,
    values: params.values,
  };
}

// The most active people of a range: active days and visits per visitor, the
// top `limit` in the order comparePowerUsers keeps, each with their visitor
// row by its key. A visitor whose row has aged out is not listed.
export function powerUsersSql(
  siteId: string,
  range: Range,
  days: readonly number[],
  minDays: number,
  limit: number,
): Statement {
  const params = new Params();
  const where = humanStays(siteId, range, params);
  const starts = params.add([...days]);
  const least = params.add(minDays);
  const keep = params.add(limit);
  return {
    text: `
SELECT top.active_days, top.visits, ${VISITOR_COLUMNS}
  FROM (
    SELECT s.visitor_id,
           count(DISTINCT width_bucket(s.started_at, ${starts}::bigint[])) AS active_days,
           count(*) AS visits
      FROM ${SESSIONS} s
     WHERE ${where}
     GROUP BY 1
    HAVING count(DISTINCT width_bucket(s.started_at, ${starts}::bigint[])) >= ${least}
     ORDER BY 2 DESC, 3 DESC, 1 DESC
     LIMIT ${keep}
  ) top
  JOIN ${VISITORS} v ON v.site_id = ${params.add(siteId)} AND v.id = top.visitor_id`,
    values: params.values,
  };
}

// Who converted, with what first brought them and the stay they converted in:
// the goal's rows of the range, each visitor's first conversion leading (the
// earliest, a row with no stay before one with), and both lookups by key in
// the same statement. One row per converter.
export function attributionSql(siteId: string, span: Range, goal: GoalMatch): Statement {
  const params = new Params();
  const at = spanOf(siteId, span, params);
  const reached = goalWhere(at, false, goal, params);
  return {
    text: `
WITH converted AS (
    SELECT DISTINCT ON (g.visitor_id) g.visitor_id, g.session_id,
           count(*) OVER (PARTITION BY g.visitor_id) AS completions
      FROM ${EVENTS} g
     WHERE ${reached}
     ORDER BY g.visitor_id, g.ts, g.session_id NULLS FIRST)
SELECT converted.completions, known.first_touch,
       stay.id IS NOT NULL AS stayed, stay.channel, stay.referrer, stay.utm, stay.entry_path
  FROM converted
  LEFT JOIN ${VISITORS} known ON known.site_id = ${at.site} AND known.id = converted.visitor_id
  LEFT JOIN ${SESSIONS} stay ON stay.site_id = ${at.site} AND stay.id = converted.session_id`,
    values: params.values,
  };
}

// ---------------------------------------------------------------- health

// The vital and error reads walk (site_id, type, ts), so they read only their
// own rows; crawlers are never measured.
function rowsOf(type: 'vital' | 'error', siteId: string, range: Range, params: Params): string {
  return `e.site_id = ${params.add(siteId)} AND e.type = '${type}' AND e.ts >= ${params.add(range.from)} AND e.ts < ${params.add(range.to)} AND e.bot = FALSE`;
}

// The page a measurement or an error is reported under: its route, else its
// path, else nothing.
const PAGE = `coalesce(e.route, e.path, '')`;

// The bucket of one measurement, written as health.ts's vitalBucket writes it:
// the same additions, products and roundings of the same doubles, so the
// adapters cannot disagree about which bucket a value is in. Null for a value
// nobody could have measured. Postgres orders NaN above every number, where
// the comparison in JS is simply false, so NaN is named.
export const VITAL_BUCKET_SQL = `CASE
  WHEN e.value = 'NaN'::float8 OR e.value < 0
    OR e.value > CASE WHEN e.name = 'CLS' THEN ${VITAL_SCALES.CLS.max} ELSE ${VITAL_SCALES.LCP.max} END::float8
    THEN NULL
  WHEN e.name = 'CLS' THEN ceil(floor(e.value * 1000::float8 + 0.5::float8) / 10::float8)
  ELSE ceil(floor(e.value + 0.5::float8) / 10::float8)
END`;

// One row per page, device, metric and bucket: the histograms foldVitals takes
// its percentiles from. A count per bucket, never a measurement.
export function vitalsSql(siteId: string, range: Range, device?: string): Statement {
  const params = new Params();
  const where = rowsOf('vital', siteId, range, params);
  const metrics = params.add([...VITAL_METRICS]);
  const only = device === undefined ? '' : `AND e.device = ${params.add(device)}`;
  return {
    text: `
SELECT measured.page, measured.device, measured.metric, measured.bucket, count(*) AS n
  FROM (
    SELECT ${PAGE} AS page, coalesce(e.device, '') AS device, e.name AS metric,
           ${VITAL_BUCKET_SQL} AS bucket
      FROM ${EVENTS} e
     WHERE ${where} AND e.name = ANY(${metrics}::text[]) AND e.value IS NOT NULL ${only}
  ) measured
 WHERE measured.bucket IS NOT NULL
 GROUP BY 1, 2, 3, 4`,
    values: params.values,
  };
}

// The biggest messages of the range, cut in the database in the order
// foldErrors sorts by, each with its newest row as the sample and beside it
// how many messages the range has in all.
export function errorMessagesSql(siteId: string, range: Range, limit: number): Statement {
  const params = new Params();
  const where = rowsOf('error', siteId, range, params);
  const again = rowsOf('error', siteId, range, params);
  return {
    text: `
SELECT top.message, top.count, top.first_seen, top.last_seen, top.messages,
       sample.at, sample.page, sample.browser, sample.frame, sample.stack
  FROM (
    SELECT grouped.*, count(*) OVER () AS messages
      FROM (
        SELECT coalesce(e.name, '') AS message, count(*) AS count,
               min(e.ts) AS first_seen, max(e.ts) AS last_seen
          FROM ${EVENTS} e
         WHERE ${where}
         GROUP BY 1
      ) grouped
     ORDER BY grouped.count DESC, grouped.last_seen DESC, grouped.message COLLATE "C"
     LIMIT ${params.add(limit)}
  ) top
  CROSS JOIN LATERAL (
    SELECT e.ts AS at, ${PAGE} AS page, coalesce(e.browser, '') AS browser, e.frame, e.stack
      FROM ${EVENTS} e
     WHERE ${again} AND coalesce(e.name, '') = top.message
     ORDER BY e.ts DESC, e.seq DESC
     LIMIT 1
  ) sample`,
    values: params.values,
  };
}

// Every error row of the range and the distinct visitors behind them.
export function errorTotalsSql(siteId: string, range: Range): Statement {
  const params = new Params();
  const where = rowsOf('error', siteId, range, params);
  return {
    text: `SELECT count(*) AS total, count(DISTINCT e.visitor_id) AS visitors FROM ${EVENTS} e WHERE ${where}`,
    values: params.values,
  };
}

// For the listed messages only: how many people met each, and its most common
// pages and browsers.
export function errorFacetsSql(siteId: string, range: Range, messages: string[]): Statement {
  const params = new Params();
  const where = rowsOf('error', siteId, range, params);
  const listed = params.add(messages);
  const top = (kind: string, column: string): string => `
SELECT '${kind}' AS kind, ranked.message, ranked.key, ranked.n
  FROM (SELECT message, ${column} AS key, count(*) AS n,
               row_number() OVER (PARTITION BY message
                                  ORDER BY count(*) DESC, ${column} COLLATE "C") AS place
          FROM met GROUP BY message, ${column}) ranked
 WHERE ranked.place <= ${ERROR_FACET_LIMIT}`;
  return {
    text: `
WITH met AS (
    SELECT coalesce(e.name, '') AS message, e.visitor_id, ${PAGE} AS page,
           coalesce(e.browser, '') AS browser
      FROM ${EVENTS} e
     WHERE ${where} AND coalesce(e.name, '') = ANY(${listed}::text[]))
SELECT 'people' AS kind, message, NULL AS key, count(DISTINCT visitor_id) AS n FROM met GROUP BY message
UNION ALL${top('page', 'page')}
UNION ALL${top('browser', 'browser')}`,
    values: params.values,
  };
}

// One row per person identified in the range: whether a server row carries
// them, and whether a browser row does. The match is bounded to the rows that
// have a userId at all, so the walk is of the partial (site_id, user_id, ts)
// index and the anonymous majority of the range is never read.
export function coverageSql(siteId: string, range: Range): Statement {
  return {
    text: `
SELECT e.user_id AS "userId",
       bool_or(e.source IS NOT DISTINCT FROM 'server') AS server,
       bool_or(e.source IS DISTINCT FROM 'server') AS browser
  FROM ${EVENTS} e
 WHERE e.site_id = $1 AND e.user_id > '' AND e.ts >= $2 AND e.ts < $3 AND e.bot = FALSE
 GROUP BY 1`,
    values: [siteId, range.from, range.to],
  };
}
