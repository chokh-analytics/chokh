import type { Pool } from 'pg';

import { createPartitionManager } from '../partitions.js';

// A busy quarter, for the tests that read a plan rather than an answer.
//
// Three sites over ninety days: 300,000 events in four monthly partitions,
// 20,000 visitors and 40,000 stays. The site the tests ask about holds a tenth
// of every table, so a statement that forgot the site, or walked a whole
// table, shows in its plan. Rows are written in time order, the way a
// collector writes them. Everything is generated in the database from a
// counter, so the same call seeds the same rows.

export const SEED_NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
export const SEED_DAYS = 90;
export const SEED_EVENTS = 300_000;
export const SEED_VISITORS = 20_000;
export const SEED_STAYS = 40_000;
export const SEED_SITE = 's_test';
export const SEED_TIMEZONE = 'Asia/Dhaka';

const DAY = 24 * 60 * 60 * 1000;
export const SEED_FROM = SEED_NOW - SEED_DAYS * DAY;

// A tenth of the visitors belong to the site under test, three tenths to a
// second and the rest to a third.
const SITE_OF = (n: string): string =>
  `CASE WHEN (${n}) % 10 = 0 THEN '${SEED_SITE}' WHEN (${n}) % 10 <= 3 THEN 's_mid' ELSE 's_big' END`;

export async function seedQuarter(pool: Pool): Promise<void> {
  const months = createPartitionManager(pool, () => SEED_NOW);
  await months.ensure(Array.from({ length: SEED_DAYS + 1 }, (_, day) => SEED_FROM + day * DAY));

  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    for (const [id, domain] of [
      [SEED_SITE, 'test.example'],
      ['s_mid', 'mid.example'],
      ['s_big', 'big.example'],
    ]) {
      await client.query(
        `INSERT INTO sites (id, name, settings) VALUES ($1, $1, $2::jsonb)`,
        [id, JSON.stringify({ timezone: SEED_TIMEZONE, retentionDays: 180 })],
      );
      await client.query(`INSERT INTO site_domains (domain, site_id, position) VALUES ($1, $2, 1)`, [
        domain,
        id,
      ]);
    }

    // Each visitor has two stays; an event belongs to one of its visitor's.
    await client.query(
      `INSERT INTO events
         (site_id, ts, received_at, type, visitor_id, session_id, user_id, path, route, referrer,
          utm, geo, ua, screen, lang, bot, source, name, status, props, duration, scroll_depth, value)
       SELECT ${SITE_OF('who.n')}, moment.ts, moment.ts,
              CASE WHEN i % 20 = 0 THEN 'event' WHEN i % 20 = 1 THEN 'leave'
                   WHEN i % 20 = 2 THEN 'vital' WHEN i % 50 = 3 THEN 'error' ELSE 'pageview' END,
              'v' || who.n,
              'x' || (who.n * 2 + i % 2),
              CASE WHEN who.n % 20 = 0 THEN 'u' || who.n END,
              '/p' || (i * 7 % 200),
              '/p' || (i * 7 % 200),
              CASE WHEN i % 3 = 0 THEN 'https://ref' || (i % 40) || '.example/' END,
              CASE WHEN i % 4 = 0 THEN jsonb_build_object('source', 'src' || (i % 12), 'campaign', 'camp' || (i % 30)) END,
              jsonb_build_object('country', 'C' || (who.n % 60), 'city', 'City' || (who.n % 400)),
              jsonb_build_object('browser', 'B' || (who.n % 6), 'os', 'O' || (who.n % 5),
                                 'device', CASE WHEN who.n % 3 = 0 THEN 'mobile' ELSE 'desktop' END),
              '1920x1080', 'en', i % 25 = 7,
              CASE WHEN i % 40 = 0 THEN 'server' END,
              CASE WHEN i % 20 = 0 THEN CASE WHEN i % 60 = 0 THEN 'purchase' ELSE 'signup' END
                   WHEN i % 20 = 2 THEN 'LCP' WHEN i % 50 = 3 THEN 'TypeError: x is undefined' END,
              CASE WHEN i % 90 = 5 THEN '404' END,
              CASE WHEN i % 20 = 0 THEN jsonb_build_object('plan', 'p' || (i % 4), 'ab.test', 'a') END,
              CASE WHEN i % 20 = 1 THEN (i % 300) * 1000 END,
              CASE WHEN i % 20 = 1 THEN (i % 5) * 25 END,
              CASE WHEN i % 20 = 2 THEN (i % 4000)::float8 END
         FROM generate_series(1, ${SEED_EVENTS}) AS i
        CROSS JOIN LATERAL (SELECT (i::bigint * 7919) % ${SEED_VISITORS} AS n) who
        CROSS JOIN LATERAL (
          SELECT ${SEED_FROM}::bigint + (i::bigint * ${SEED_DAYS * DAY} / ${SEED_EVENTS + 1}) AS ts
        ) moment`,
    );

    await client.query(
      `INSERT INTO sessions
         (site_id, id, visitor_id, user_id, started_at, last_seen_at, entry_path, exit_path,
          pageviews, events, duration, referrer, channel, utm, geo, ua, bot, is_new)
       SELECT ${SITE_OF('k / 2')}, 'x' || k, 'v' || (k / 2),
              CASE WHEN (k / 2) % 20 = 0 THEN 'u' || (k / 2) END,
              began.started, began.started + (k % 50) * 60000,
              '/p' || (k % 200), '/p' || (k * 3 % 200),
              1 + k % 6, k % 3, (k % 50) * 60000,
              CASE WHEN k % 3 = 0 THEN 'https://ref' || (k % 40) || '.example/' END,
              (ARRAY['direct', 'organic', 'social', 'referral', 'email'])[1 + k % 5],
              CASE WHEN k % 4 = 0 THEN jsonb_build_object('source', 'src' || (k % 12), 'campaign', 'camp' || (k % 30)) END,
              jsonb_build_object('country', 'C' || ((k / 2) % 60), 'city', 'City' || ((k / 2) % 400)),
              jsonb_build_object('browser', 'B' || ((k / 2) % 6), 'os', 'O' || ((k / 2) % 5),
                                 'device', CASE WHEN (k / 2) % 3 = 0 THEN 'mobile' ELSE 'desktop' END),
              k % 25 = 7, k % 2 = 0
         FROM generate_series(0, ${SEED_STAYS - 1}) AS k
        CROSS JOIN LATERAL (
          SELECT ${SEED_FROM}::bigint + (k::bigint * ${SEED_DAYS * DAY} / ${SEED_STAYS}) AS started
        ) began`,
    );

    await client.query(
      `INSERT INTO visitors
         (site_id, id, user_id, traits, first_seen_at, last_seen_at, sessions, pageviews,
          places, devices, ips, first_touch, search)
       SELECT ${SITE_OF('n')}, 'v' || n,
              CASE WHEN n % 20 = 0 THEN 'u' || n END,
              CASE WHEN n % 20 = 0 THEN jsonb_build_object('name', 'Person ' || n) END,
              ${SEED_FROM}::bigint + n::bigint * 1000,
              ${SEED_FROM}::bigint + (n::bigint * ${SEED_DAYS * DAY} / ${SEED_VISITORS}),
              2, 7, '[]'::jsonb, ARRAY['B1 on O1'], ARRAY['203.0.113.' || (n % 250)],
              jsonb_build_object('at', ${SEED_FROM}, 'channel', 'organic'),
              ARRAY['v' || n] ||
                CASE WHEN n % 20 = 0 THEN ARRAY['u' || n, 'person ' || n] ELSE ARRAY[]::text[] END
         FROM generate_series(0, ${SEED_VISITORS - 1}) AS n`,
    );

    // The rolled history of the same quarter: a day's totals and two
    // dimensions of two hundred values each, for every site.
    await client.query(
      `INSERT INTO rollups_daily
         (site_id, date, dim, key, visitors, pageviews, visits, bounces, duration_sum)
       SELECT site.id, (DATE '2026-06-20' + day)::date, value.dim, value.key, 10, 20, 8, 3, 90000
         FROM (VALUES ('${SEED_SITE}'), ('s_mid'), ('s_big')) AS site(id)
        CROSS JOIN generate_series(0, ${SEED_DAYS - 1}) AS day
        CROSS JOIN LATERAL (
          SELECT 'total' AS dim, '' AS key
          UNION ALL SELECT 'page', '/p' || n FROM generate_series(0, 199) AS n
          UNION ALL SELECT 'country', 'C' || n FROM generate_series(0, 199) AS n
        ) value`,
    );

    // The planner reads statistics, and a table that was just filled has none
    // until autovacuum gets to it.
    await client.query('ANALYZE events');
    await client.query('ANALYZE sessions');
    await client.query('ANALYZE visitors');
    await client.query('ANALYZE rollups_daily');
  } finally {
    await client.query('RESET statement_timeout').catch(() => undefined);
    client.release();
  }
}

export interface Scan {
  relation: string;
  node: string;
  index?: string;
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function collect(node: PlanNode, into: Scan[]): void {
  if (node['Relation Name'] !== undefined) {
    const scan: Scan = { relation: node['Relation Name'], node: node['Node Type'] };
    // A bitmap heap scan names its index on the node below it.
    const index = node['Index Name'] ?? bitmapIndex(node);
    if (index !== undefined) scan.index = index;
    into.push(scan);
  }
  for (const child of node.Plans ?? []) {
    collect(child, into);
  }
}

function bitmapIndex(node: PlanNode): string | undefined {
  for (const child of node.Plans ?? []) {
    if (child['Index Name'] !== undefined) return child['Index Name'];
    const deeper = bitmapIndex(child);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

// Every table a statement's plan reads, with how it reads it. The plan is the
// one Postgres makes for these very parameters, with no planner setting
// changed: nothing here turns sequential scans off to get the answer wanted.
export async function scansOf(
  pool: Pool,
  statement: { text: string; values: unknown[] },
): Promise<Scan[]> {
  const result = await pool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
    `EXPLAIN (FORMAT JSON) ${statement.text}`,
    statement.values,
  );
  const scans: Scan[] = [];
  const plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
  if (plan !== undefined) {
    collect(plan, scans);
  }
  return scans;
}
