import {
  ACTIVITY_WINDOWS,
  VITAL_METRICS,
  activityPlan,
  addVisitorDays,
  compareFunnelRows,
  conversionMatcher,
  emptyActivityTally,
  funnelDepth,
  funnelWindowMs,
  routeMatchers,
  routeOf,
  vitalBucket,
  type FunnelRead,
  type FunnelRow,
  type GoalMatch,
  type StoredEvent,
  type VisitorDays,
} from '@chokh/store';
import { FUNNEL_SEQUENCE_COUNT, funnelSequences } from '@chokh/store/conformance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { activityTallyOf } from './depth.js';
import {
  VITAL_BUCKET_SQL,
  activityFoldSql,
  activitySql,
  attributionSql,
  cohortSql,
  coverageSql,
  errorFacetsSql,
  errorMessagesSql,
  errorTotalsSql,
  funnelFoldSql,
  funnelSql,
  journeysSql,
  powerUsersSql,
  vitalsSql,
} from './depth.sql.js';
import { apply } from './migrate.js';
import { createPostgresStore } from './postgres.store.js';
import { PURGE_EVENTS_SQL, PURGE_SESSIONS_SQL, PURGE_VISITORS_SQL } from './purge.js';
import { Params, goalReached, type Statement } from './reads.sql.js';
import { routeSql } from './rollup.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';
import {
  SEED_FROM,
  SEED_NOW,
  SEED_SITE,
  SEED_TIMEZONE,
  scansOf,
  seedQuarter,
  type Scan,
} from './testing/seed.js';

const DAY = 24 * 60 * 60 * 1000;

// The same small generator the suite's own seeded data comes from, so a run
// draws the same rows every time.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// The two folds this adapter writes in SQL, held to the shared ones in JS on
// seeded rows; the bucket of a measurement and the two patterns likewise. The
// conformance suite proves the answers; these prove the mechanism it cannot
// reach, on far more shapes than a fixture has.
describe('what is folded in SQL agrees with the shared fold', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('folds');
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('the funnel', () => {
    const sequences = funnelSequences();
    const MOST_STEPS = 8;
    const columns = Array.from({ length: MOST_STEPS }, (_, index) => `h${index}`);

    beforeAll(async () => {
      await db.pool.query(
        `CREATE TABLE fold_hits (visitor_id text, session_id text, ts bigint, ${columns
          .map((name) => `${name} boolean`)
          .join(', ')})`,
      );
      const rows: unknown[] = [];
      sequences.forEach((sequence, index) => {
        sequence.rows.forEach((row, at) => {
          const record: Record<string, unknown> = {
            visitor_id: `s${index}`,
            // Two visits per sequence, alternating, so the visit window's
            // partition is folded too.
            session_id: `s${index}_${at % 2}`,
            ts: row.ts,
          };
          columns.forEach((name, step) => {
            record[name] = row.hits[step] === true;
          });
          rows.push(record);
        });
      });
      // In the order they were drawn, so the database has to put them in
      // funnel order itself, equal instants included.
      await db.pool.query(
        `INSERT INTO fold_hits SELECT * FROM jsonb_populate_recordset(NULL::fold_hits, $1::jsonb)`,
        [JSON.stringify(rows)],
      );
    });

    async function sqlDepth(index: number, byVisit: boolean): Promise<number> {
      const sequence = sequences[index]!;
      const kept = columns.slice(0, sequence.steps).join(', ');
      const result = await db.pool.query<{ depth: number }>(
        `WITH hits AS (SELECT visitor_id, session_id, ts, ${kept} FROM fold_hits WHERE visitor_id = $1),
           ${funnelFoldSql('hits', sequence.steps, '$2::bigint', byVisit)}
         SELECT depth FROM depth`,
        [`s${index}`, sequence.windowMs],
      );
      return Number(result.rows[0]?.depth ?? 0);
    }

    it(`agrees with funnelDepth on the same ${FUNNEL_SEQUENCE_COUNT} seeded sequences`, async () => {
      expect(sequences).toHaveLength(FUNNEL_SEQUENCE_COUNT);
      let ties = 0;
      let edges = 0;
      for (const [index, sequence] of sequences.entries()) {
        const ordered = [...sequence.rows].sort(compareFunnelRows);
        expect({ index, depth: await sqlDepth(index, false) }).toEqual({
          index,
          depth: funnelDepth(ordered, sequence.windowMs),
        });
        if (new Set(ordered.map((row) => row.ts)).size < ordered.length) ties += 1;
        if (ordered.some((a) => ordered.some((b) => b.ts - a.ts === sequence.windowMs))) edges += 1;
      }
      // The list is only a proof if it reaches equal times and the exact edge.
      expect(ties).toBeGreaterThan(100);
      expect(edges).toBeGreaterThan(100);
    }, 120_000);

    it('agrees on the visit window, one fold per visit and the deepest kept', async () => {
      for (const [index, sequence] of sequences.entries()) {
        const perVisit = new Map<number, FunnelRow[]>();
        sequence.rows.forEach((row, at) => {
          perVisit.set(at % 2, [...(perVisit.get(at % 2) ?? []), row]);
        });
        let depth = 0;
        for (const rows of perVisit.values()) {
          depth = Math.max(depth, funnelDepth([...rows].sort(compareFunnelRows), sequence.windowMs));
        }
        expect({ index, depth: await sqlDepth(index, true) }).toEqual({ index, depth });
      }
    }, 120_000);
  });

  it('the activity windows give the tally addVisitorDays gives, over 2,000 seeded visitors', async () => {
    const plan = activityPlan({ siteId: 's', from: SEED_NOW - 60 * DAY, to: SEED_NOW }, SEED_TIMEZONE);
    const spanDays = plan.starts.length;
    const next = random(7);
    const seeded: VisitorDays[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const days = new Set<number>();
      const count = 1 + Math.floor(next() * 10);
      for (let pick = 0; pick < count; pick += 1) days.add(Math.floor(next() * spanDays));
      const sorted = [...days].sort((left, right) => left - right);
      const roll = next();
      const first = roll < 0.3 ? null : roll < 0.8 ? sorted[0]! : sorted[sorted.length - 1]!;
      seeded.push({ days: sorted, first });
    }
    await db.pool.query('CREATE TABLE fold_seen (visitor_id text, day integer, fresh boolean)');
    await db.pool.query(
      `INSERT INTO fold_seen SELECT * FROM jsonb_populate_recordset(NULL::fold_seen, $1::jsonb)`,
      [
        JSON.stringify(
          seeded.flatMap((visitor, index) =>
            visitor.days.map((day) => ({
              visitor_id: `v${index}`,
              day,
              fresh: visitor.first === day,
            })),
          ),
        ),
      ],
    );
    const result = await db.pool.query(
      `WITH ${activityFoldSql('fold_seen', '$1::int', ACTIVITY_WINDOWS)}`,
      [plan.offset],
    );
    const expected = emptyActivityTally(plan.days);
    for (const visitor of seeded) addVisitorDays(expected, plan, visitor);
    expect(activityTallyOf(result.rows, plan)).toEqual(expected);
    // Not a trivial agreement: the windows hold people and differ.
    expect(Math.max(...expected.mau)).toBeGreaterThan(Math.max(...expected.wau));
    expect(Math.max(...expected.wau)).toBeGreaterThan(Math.max(...expected.dau));
    expect(expected.returning).toBeGreaterThan(0);
  });

  it('the bucket of a measurement is the one vitalBucket gives, seeded and at every edge', async () => {
    const next = random(11);
    const values: number[] = [
      0, 0.004, 0.005, 0.0149, 0.015, 0.1, 0.25, 0.2449999, 0.245, 4.4, 4.5, 4.99, 5, 9.5, 10.49, 10.5,
      99.999, 100, 100.0001, 2499.5, 2500, 599_999.4, 599_999.5, 600_000, 600_000.1, -0.0001, -5,
      0.1 + 0.2, 1e-9, Number.POSITIVE_INFINITY, Number.NaN,
    ];
    for (let index = 0; index < 400; index += 1) {
      values.push(next() < 0.5 ? next() * 2 : next() * 12_000);
    }
    let buckets = 0;
    for (const metric of VITAL_METRICS) {
      const result = await db.pool.query<{ ord: string; bucket: number | null }>(
        `SELECT e.ord, ${VITAL_BUCKET_SQL} AS bucket
           FROM (SELECT $1::text AS name, given.value, given.ord
                   FROM unnest($2::float8[]) WITH ORDINALITY AS given(value, ord)) e`,
        [metric, values],
      );
      expect(result.rows).toHaveLength(values.length);
      result.rows.forEach((row) => {
        const value = values[Number(row.ord) - 1]!;
        expect({ metric, value, bucket: row.bucket === null ? null : Number(row.bucket) }).toEqual({
          metric,
          value,
          bucket: vitalBucket(metric, value),
        });
        if (row.bucket !== null) buckets += 1;
      });
    }
    expect(buckets).toBeGreaterThan(1000);
  });

  it('a page goal is reached in SQL exactly when the shared matcher says so', async () => {
    const goals = [
      '/*/checkout/done',
      '/a.b',
      '/a(b)[c]+?',
      '/x*',
      '/q$^{1}|2',
      '/docs/*',
      '/ডক/*',
      '*',
      '/*',
      '/**/x',
      '/back\\slash',
      '/plain',
    ];
    const paths = [
      '/en/checkout/done',
      '/en/x/checkout/done',
      '/a.b',
      '/aXb',
      '/a(b)[c]+?',
      '/x',
      '/x\nline',
      '/xy/z',
      '/q$^{1}|2',
      '/docs/',
      '/docs/intro',
      '/docs/a/b',
      '/ডক/পাতা',
      '',
      '/',
      '//x',
      '/a/x',
      '/back\\slash',
      '/plain',
      '/plain/',
      '/Plain',
    ];
    let reached = 0;
    for (const match of goals) {
      const goal: GoalMatch = { kind: 'page', match };
      const params = new Params();
      const test = goalReached(goal, params, 'g');
      const result = await db.pool.query<{ ord: string; hit: boolean | null }>(
        `SELECT g.ord, (${test}) AS hit
           FROM (SELECT 'pageview' AS type, given.path, given.ord
                   FROM unnest($${params.values.length + 1}::text[]) WITH ORDINALITY AS given(path, ord)) g`,
        [...params.values, paths],
      );
      expect(result.rows).toHaveLength(paths.length);
      const matches = conversionMatcher(goal);
      result.rows.forEach((row) => {
        const path = paths[Number(row.ord) - 1]!;
        const expected = matches({ type: 'pageview', path } as StoredEvent);
        expect({ match, path, hit: row.hit === true }).toEqual({ match, path, hit: expected });
        if (expected) reached += 1;
      });
    }
    expect(reached).toBeGreaterThan(20);
  });

  it('a route is the one the shared rules give, first match first', async () => {
    const rules = ['/courses/:slug', '/courses/:slug/lessons/:id', '/a.b/:x', '/u/:id/(edit)', '/:lang/pricing'];
    const paths = [
      '/courses/c',
      '/courses/c/lessons/3',
      '/courses/',
      '/courses',
      '/a.b/1',
      '/aXb/1',
      '/u/7/(edit)',
      '/u/7/edit',
      '/bn/pricing',
      '/pricing',
      '/',
      '',
      '/ডক/pricing',
    ];
    const values: unknown[] = [];
    const route = routeSql(rules, (value) => {
      values.push(value);
      return `$${values.length}`;
    });
    const result = await db.pool.query<{ ord: string; route: string | null }>(
      `SELECT given.ord, ${route} AS route
         FROM unnest($${values.length + 1}::text[]) WITH ORDINALITY AS given(path, ord)`,
      [...values, paths],
    );
    const matchers = routeMatchers(rules);
    const answered = [...result.rows].sort((left, right) => Number(left.ord) - Number(right.ord));
    expect(answered.map((row) => row.route)).toEqual(paths.map((path) => routeOf(path, matchers)));
    // And with no rule at all a route is the path.
    expect(routeSql([], () => '')).toBe('path');
  });
});

// The plans of the same reads at the seeded quarter of reads.sql.test.ts:
// three sites over ninety days, 300,000 events in four monthly partitions,
// 20,000 visitors and 40,000 stays, the site asked about holding a tenth. No
// planner setting is changed.
describe('the plans of the deeper reads, at a busy quarter', () => {
  const tz = SEED_TIMEZONE;
  const week = { from: SEED_NOW - 7 * DAY, to: SEED_NOW };
  const month = { from: SEED_NOW - 30 * DAY, to: SEED_NOW };
  const SEPTEMBER = ['events_p202609'];
  const AUGUST_ON = ['events_p202608', 'events_p202609'];
  const EVERY_MONTH = ['events_p202606', 'events_p202607', 'events_p202608', 'events_p202609'];
  const funnel = (window: FunnelRead['window']): FunnelRead => ({
    window,
    steps: [
      { kind: 'page', match: '/p1' },
      { kind: 'page', match: '/p2*' },
      { kind: 'event', match: 'signup' },
    ],
  });

  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('deep_plans');
    await apply(db.pool, { now: () => SEED_NOW });
    await seedQuarter(db.pool);
  }, 600_000);

  afterAll(async () => {
    await db.drop();
  });

  async function held(statement: Statement, months: string[]): Promise<Scan[]> {
    const scans = await scansOf(db.pool, statement);
    for (const scan of scans) {
      // Next month's partition is empty, and there is nothing in it to read.
      if (scan.relation === 'events_p202610') continue;
      expect(scan.node, `${scan.relation} is read by ${scan.node}`).not.toBe('Seq Scan');
      expect(scan.index, `${scan.relation} is read through no index`).toBeDefined();
      if (scan.relation.startsWith('events')) {
        expect(months, `${scan.relation} is outside the range`).toContain(scan.relation);
      }
    }
    return scans;
  }

  const of = (scans: Scan[], prefix: string): Scan[] =>
    scans.filter((scan) => scan.relation.startsWith(prefix) && scan.relation !== 'events_p202610');

  it('a funnel walks an index on every half, in each of its four shapes', async () => {
    const none = { event: [], stay: [] };
    const plain = await held(funnelSql(SEED_SITE, week, false, none, funnel('7d'), funnelWindowMs('7d')), SEPTEMBER);
    // Who is in the segment, and how far each got.
    expect(of(plain, 'events')).toHaveLength(2);

    const byRow = { event: [{ dim: 'country' as const, op: 'is' as const, value: 'C10' }], stay: [] };
    await held(funnelSql(SEED_SITE, week, false, byRow, funnel('1d'), funnelWindowMs('1d')), SEPTEMBER);

    const byStay = { event: [], stay: [{ dim: 'channel' as const, op: 'is' as const, value: 'organic' }] };
    const stayed = await held(
      funnelSql(SEED_SITE, week, false, byStay, funnel('7d'), funnelWindowMs('7d')),
      SEPTEMBER,
    );
    expect(of(stayed, 'sessions')).toHaveLength(1);

    await held(funnelSql(SEED_SITE, month, false, none, funnel('visit'), funnelWindowMs('visit')), AUGUST_ON);
  });

  it('journeys walk the stays by when they began and the pageviews of the range', async () => {
    const plain = await held(journeysSql(SEED_SITE, week, false, { event: [], stay: [] }, 5), SEPTEMBER);
    expect(of(plain, 'sessions').map((scan) => scan.index)).toEqual(['session_site_started']);
    expect(of(plain, 'events')).toHaveLength(1);
    const filtered = await held(
      journeysSql(
        SEED_SITE,
        week,
        false,
        {
          event: [{ dim: 'browser', op: 'is', value: 'B1' }],
          stay: [{ dim: 'entry', op: 'contains', value: '/p1' }],
        },
        3,
      ),
      SEPTEMBER,
    );
    expect(of(filtered, 'events')).toHaveLength(2);
  });

  it('cohorts, activity and power users each walk (site_id, started_at) once', async () => {
    const plan = activityPlan({ siteId: SEED_SITE, from: SEED_NOW - 30 * DAY, to: SEED_NOW }, tz);
    const fourWeeks = { from: SEED_NOW - 28 * DAY, to: SEED_NOW };
    const cohorts = await held(
      cohortSql(SEED_SITE, fourWeeks, [fourWeeks.from, fourWeeks.from + 7 * DAY, fourWeeks.from + 14 * DAY]),
      [],
    );
    expect(cohorts.map((scan) => [scan.relation, scan.index])).toEqual([['sessions', 'session_site_started']]);
    // Asked for the whole quarter, every stay of the site is in the range, so
    // the range chooses nothing and either index that leads with the site
    // serves; the planner takes one of them and never the table.
    const whole = await held(cohortSql(SEED_SITE, { from: SEED_FROM, to: SEED_NOW }, [SEED_FROM]), []);
    expect(whole.map((scan) => scan.index).join()).toMatch(/^session_site_(started|last_seen)$/);
    const activity = await held(activitySql(SEED_SITE, plan.span, plan.starts, plan.offset, ACTIVITY_WINDOWS), []);
    // The fold reads the grouped stays four times over; the table is walked once.
    expect(of(activity, 'sessions').every((scan) => scan.index === 'session_site_started')).toBe(true);
    const power = await held(powerUsersSql(SEED_SITE, plan.range, plan.starts.slice(plan.offset), 2, 20), []);
    expect(of(power, 'sessions').map((scan) => scan.index)).toEqual(['session_site_started']);
    // And each of the page's people by their key, never the visitors table.
    expect(of(power, 'visitors').map((scan) => scan.index)).toEqual(['visitors_pkey']);
  });

  it("attribution walks the goal's own rows, then each converter by key", async () => {
    const scans = await held(attributionSql(SEED_SITE, month, { kind: 'event', match: 'signup' }), AUGUST_ON);
    expect(of(scans, 'events').every((scan) => /_site_id_type_ts_idx$/.test(scan.index ?? ''))).toBe(true);
    expect(of(scans, 'visitors').map((scan) => scan.index)).toEqual(['visitors_pkey']);
    expect(of(scans, 'sessions').map((scan) => scan.index)).toEqual(['sessions_pkey']);
  });

  it('the health reads walk (site_id, type, ts) over their own rows only', async () => {
    const typed = /_site_id_type_ts_idx$/;
    for (const statement of [
      vitalsSql(SEED_SITE, month),
      vitalsSql(SEED_SITE, month, 'mobile'),
      errorMessagesSql(SEED_SITE, month, 50),
      errorTotalsSql(SEED_SITE, month),
      errorFacetsSql(SEED_SITE, month, ['TypeError: x is undefined']),
    ]) {
      const scans = await held(statement, AUGUST_ON);
      expect(of(scans, 'events').length).toBeGreaterThan(0);
      for (const scan of of(scans, 'events')) {
        expect(scan.index).toMatch(typed);
      }
    }
  });

  it('coverage walks the partial user index over the identified rows only', async () => {
    const scans = await held(coverageSql(SEED_SITE, month), AUGUST_ON);
    expect(of(scans, 'events').map((scan) => scan.relation).sort()).toEqual(AUGUST_ON);
    for (const scan of of(scans, 'events')) {
      expect(scan.index).toMatch(/_site_id_user_id_ts_idx$/);
    }
  });

  it('the purge deletes by (site_id, ts) in the months before the instant, and the rest by an index', async () => {
    const before = Date.UTC(2026, 7, 10);
    const events = await held({ text: PURGE_EVENTS_SQL, values: [SEED_SITE, before] }, EVERY_MONTH.slice(0, 3));
    // June and July whole, August up to the instant; September is not touched.
    expect(of(events, 'events').map((scan) => scan.relation).sort()).toEqual(EVERY_MONTH.slice(0, 3));
    for (const scan of of(events, 'events')) {
      expect(scan.index).toMatch(/_site_id_ts_idx$/);
    }
    const stays = await held({ text: PURGE_SESSIONS_SQL, values: [SEED_SITE, before] }, []);
    expect(stays.map((scan) => scan.index)).toEqual(['session_site_last_seen']);
    const people = await held({ text: PURGE_VISITORS_SQL, values: [SEED_SITE, before] }, []);
    expect(people.map((scan) => scan.index)).toEqual(['visitor_site_last_seen']);
  });

  it('lets the long jobs run past the limit that cancels a report', async () => {
    // A store whose statements may run 150 ms, and a database in which the
    // statement each long job is made of takes 400 ms whatever the machine: a
    // trigger sleeps once per statement. Not timed against real work, because
    // how long real work takes is the machine's business (a purge of 180,000
    // rows took 168 ms on a CI runner).
    const LIMIT = 150;
    await db.pool.query(
      `CREATE FUNCTION slow_statement() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NULL; END $$`,
    );
    const slow = (name: string, action: string, table: string): Promise<unknown> =>
      db.pool.query(
        `CREATE TRIGGER ${name} AFTER ${action} ON ${table}
           FOR EACH STATEMENT EXECUTE FUNCTION slow_statement()`,
      );
    const store = await createPostgresStore({
      url: db.url,
      statementTimeoutMs: LIMIT,
      now: () => SEED_NOW,
    });
    // The same statement, sent on its own, is cancelled: the limit is real and
    // the trigger is what it says.
    const cancelled = async (statement: string): Promise<void> => {
      const refused = await store.pool.query(statement).catch((error: unknown) => error);
      expect((refused as { code?: string }).code, statement).toBe('57014');
    };
    try {
      // A route regroup rewrites every row of a site whose route changes.
      await store.updateSite('s_mid', { settings: { routeGroups: ['/:page'] } });
      await slow('slow_regroup', 'UPDATE', 'events');
      await cancelled(`UPDATE events SET route = route WHERE FALSE`);
      const regrouped = await store.regroupRoutes('s_mid');
      expect(regrouped.events).toBe(90_000);
      const changed = await db.pool.query(
        `SELECT count(*)::int AS n FROM events WHERE site_id = 's_mid' AND route = '/:page'`,
      );
      expect(changed.rows[0]?.n).toBe(90_000);
      await db.pool.query('DROP TRIGGER slow_regroup ON events');

      // A rollup replaces a day.
      await slow('slow_rollup', 'INSERT', 'rollups_daily');
      await cancelled(`INSERT INTO rollups_daily SELECT * FROM rollups_daily WHERE FALSE`);
      const rolled = await store.rollupDay(SEED_SITE, '2026-09-10');
      expect(rolled.rows).toBeGreaterThan(0);
      await db.pool.query('DROP TRIGGER slow_rollup ON rollups_daily');

      // And a purge deletes a site's detail.
      await slow('slow_purge', 'DELETE', 'sessions');
      await cancelled(`DELETE FROM sessions WHERE FALSE`);
      const purged = await store.purge('s_big', SEED_NOW + DAY);
      expect(purged).toEqual({ events: 180_000, sessions: 24_000, visitors: 12_000 });
    } finally {
      await store.close();
    }
  }, 300_000);
});
