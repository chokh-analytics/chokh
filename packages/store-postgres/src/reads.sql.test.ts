import {
  DIMENSIONS,
  EVENT_PATH_BY_DIMENSION,
  SESSION_DIMENSIONS,
  SESSION_PATH_BY_DIMENSION,
  bucketsBetween,
  type Filter,
  type GoalMatch,
} from '@chokh/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INGEST_READ_SQL, ingestWriteSql } from './ingest.js';
import { apply } from './migrate.js';
import { peopleSql, profileEventsSql, profileSummarySql, profileVisitorsSql } from './people.js';
import {
  conversionBreakdownSql,
  conversionTotalsSql,
  dayStarts,
  engagementSql,
  eventColumn,
  eventKey,
  eventsSql,
  goalStatsSql,
  propertyKeysSql,
  propertyValuesSql,
  rawBreakdownSql,
  rawTotalsByBucketSql,
  rawTotalsSql,
  rollupBreakdownSql,
  rollupTotalsByDateSql,
  rollupTotalsSql,
  sessionBreakdownSql,
  sessionColumn,
  sessionConversionBreakdownSql,
  sessionKey,
  sessionSourcedBreakdownSql,
  sessionTotalsByBucketSql,
  sessionTotalsSql,
  type Statement,
} from './reads.sql.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';
import {
  SEED_EVENTS,
  SEED_NOW,
  SEED_SITE,
  SEED_STAYS,
  SEED_TIMEZONE,
  SEED_VISITORS,
  scansOf,
  seedQuarter,
  type Scan,
} from './testing/seed.js';

describe('where a dimension lives', () => {
  it('has a column for every field the contract reads a dimension from', () => {
    for (const dim of DIMENSIONS) {
      if (EVENT_PATH_BY_DIMENSION[dim] !== undefined) {
        expect(eventColumn(dim), `event ${dim}`).toMatch(/^[a-z_]+$/);
        expect(eventKey(dim), `event key ${dim}`).not.toBeNull();
      }
      if (SESSION_PATH_BY_DIMENSION[dim] !== undefined) {
        expect(sessionColumn(dim), `stay ${dim}`).toMatch(/^[a-z_]+$/);
        expect(sessionKey(dim), `stay key ${dim}`).not.toBeNull();
      }
      // Every dimension is answered by one side or the other.
      expect(eventKey(dim) ?? sessionKey(dim), dim).not.toBeNull();
    }
  });

  it('reads the event dimension off custom events only, and the bot side as text', () => {
    expect(eventKey('event')).toBe(`CASE WHEN e.type = 'event' THEN e.name END`);
    expect(eventKey('bot')).toBe('e.bot::text');
    expect(eventKey('entry')).toBeNull();
    expect(sessionKey('page')).toBeNull();
  });
});

// The plans, at a seeded size: three sites over ninety days, 300,000 events in
// four monthly partitions, 20,000 visitors and 40,000 stays, the site asked
// about holding a tenth, written in time order and analysed. No planner
// setting is changed anywhere in this file.
//
// What is held: every read of events walks a declared index and touches only
// the months its range overlaps; every read of stays, visitors and rollups
// walks an index. A partition with no rows in it may be read any way the
// planner likes, since there is nothing in it to read.
describe('the plans, at a busy quarter', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const tz = SEED_TIMEZONE;
  const week = { from: SEED_NOW - 7 * DAY, to: SEED_NOW };
  const month = { from: SEED_NOW - 30 * DAY, to: SEED_NOW };
  const SEPTEMBER = ['events_p202609'];
  const AUGUST_ON = ['events_p202608', 'events_p202609'];
  const EVERY_MONTH = ['events_p202606', 'events_p202607', 'events_p202608', 'events_p202609'];
  const EVENT_INDEXES = /_site_id_ts_idx$|_site_id_type_ts_idx$|_site_id_visitor_id_ts_idx$|_site_id_user_id_ts_idx$/;
  const signup: GoalMatch = { kind: 'event', match: 'signup' };
  const pattern: GoalMatch = { kind: 'page', match: '/p1*' };

  let db: TestDatabase;
  let empty: Set<string>;

  beforeAll(async () => {
    db = await createTestDatabase('plans');
    await apply(db.pool, { now: () => SEED_NOW });
    await seedQuarter(db.pool);
    const counts = await db.pool.query<{ part: string; n: number }>(
      `SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM events GROUP BY 1`,
    );
    const filled = new Set(counts.rows.map((row) => row.part));
    empty = new Set(['events_p202610'].filter((name) => !filled.has(name)));
  }, 600_000);

  afterAll(async () => {
    await db.drop();
  });

  async function held(statement: Statement, months: string[], indexes?: RegExp): Promise<Scan[]> {
    const scans = await scansOf(db.pool, statement);
    const events = scans.filter((scan) => scan.relation.startsWith('events') && !empty.has(scan.relation));
    for (const scan of events) {
      expect(scan.node, `${scan.relation} is read by ${scan.node}`).not.toBe('Seq Scan');
      expect(scan.index ?? '', `${scan.relation} is read through ${scan.index}`).toMatch(
        indexes ?? EVENT_INDEXES,
      );
      expect(months, `${scan.relation} is outside the range`).toContain(scan.relation);
    }
    for (const scan of scans.filter((each) => !each.relation.startsWith('events'))) {
      expect(scan.node, `${scan.relation} is read by ${scan.node}`).not.toBe('Seq Scan');
      expect(scan.index, `${scan.relation} is read through no index`).toBeDefined();
    }
    return scans;
  }

  const read = (scans: Scan[], relation: string): Scan[] =>
    scans.filter((scan) => scan.relation === relation);

  it('is seeded to the size it says', async () => {
    const sizes = await db.pool.query<{ events: number; stays: number; visitors: number; mine: number }>(
      `SELECT (SELECT count(*) FROM events)::int AS events,
              (SELECT count(*) FROM sessions)::int AS stays,
              (SELECT count(*) FROM visitors)::int AS visitors,
              (SELECT count(*) FROM events WHERE site_id = $1)::int AS mine`,
      [SEED_SITE],
    );
    expect(sizes.rows[0]).toEqual({
      events: SEED_EVENTS,
      stays: SEED_STAYS,
      visitors: SEED_VISITORS,
      mine: SEED_EVENTS / 10,
    });
  });

  it('totals walk (site_id, ts) in the months of the range and no others', async () => {
    const one = await held(rawTotalsSql(SEED_SITE, week, tz, false, undefined), SEPTEMBER);
    expect(read(one, 'events_p202609')).toHaveLength(1);
    const two = await held(rawTotalsSql(SEED_SITE, month, tz, false, undefined), AUGUST_ON);
    expect(two.map((scan) => scan.relation).sort()).toEqual(AUGUST_ON);
    const crawlers = [{ dim: 'bot', op: 'is', value: 'true' }] satisfies Filter[];
    await held(rawTotalsSql(SEED_SITE, week, tz, true, crawlers), SEPTEMBER);
  });

  it('a filter a row carries is a test on the rows the same walk reads', async () => {
    const filters: Filter[] = [
      { dim: 'country', op: 'is', value: 'C10' },
      { dim: 'page', op: 'is_not', value: '/p3' },
      { dim: 'referrer', op: 'contains', value: 'ref1' },
      { dim: 'event', op: 'is_not', value: 'signup' },
    ];
    const scans = await held(rawTotalsSql(SEED_SITE, week, tz, false, filters), SEPTEMBER);
    expect(scans).toHaveLength(1);
  });

  it('a filter only a stay carries is a semi-join onto an index of the stays', async () => {
    const filters: Filter[] = [
      { dim: 'channel', op: 'is', value: 'organic' },
      { dim: 'entry', op: 'contains', value: '/p1' },
    ];
    const scans = await held(rawTotalsSql(SEED_SITE, week, tz, false, filters), SEPTEMBER);
    expect(read(scans, 'sessions')).toHaveLength(1);
    expect(read(scans, 'sessions')[0]?.index).toMatch(/^session_site_(started|last_seen)$/);
  });

  it.each(DIMENSIONS.filter((dim) => !SESSION_DIMENSIONS.includes(dim)))(
    'a breakdown by %s walks an index',
    async (dim) => {
      await held(rawBreakdownSql(SEED_SITE, week, tz, [dim], false, undefined), SEPTEMBER);
    },
  );

  it('every rolled dimension at once is still one walk of the day', async () => {
    const day = { from: SEED_NOW - 2 * DAY, to: SEED_NOW - DAY };
    const dims = DIMENSIONS.filter((dim) => !SESSION_DIMENSIONS.includes(dim) && dim !== 'bot');
    const scans = await held(rawBreakdownSql(SEED_SITE, day, tz, dims, false, undefined), SEPTEMBER);
    expect(scans).toHaveLength(1);
  });

  it('the visit numbers walk the stays by when they began', async () => {
    const started = /^session_site_started$/;
    const scans = [
      ...(await held(sessionTotalsSql(SEED_SITE, week, false, undefined), [])),
      ...(await held(sessionBreakdownSql(SEED_SITE, week, ['country', 'browser'], false, undefined), [])),
      ...(await held(
        sessionSourcedBreakdownSql(SEED_SITE, week, tz, ['entry', 'exit', 'channel'], false, undefined),
        [],
      )),
      ...(await held(
        sessionTotalsByBucketSql(SEED_SITE, week, dayStarts(week, tz), false, undefined),
        [],
      )),
    ];
    expect(scans).toHaveLength(4);
    for (const scan of scans) {
      expect(scan.relation).toBe('sessions');
      expect(scan.index).toMatch(started);
    }
  });

  it('a series is one walk for the whole range, by day and by hour', async () => {
    const days = await held(
      rawTotalsByBucketSql(SEED_SITE, month, dayStarts(month, tz), false, undefined),
      AUGUST_ON,
    );
    expect(days.map((scan) => scan.relation).sort()).toEqual(AUGUST_ON);
    const twoDays = { from: SEED_NOW - 48 * HOUR, to: SEED_NOW };
    const hours = bucketsBetween(twoDays.from, twoDays.to, 'hour', tz);
    expect(await held(rawTotalsByBucketSql(SEED_SITE, twoDays, hours, false, undefined), SEPTEMBER)).toHaveLength(1);
  });

  it('the rollups are read by their key and by (site_id, dim, date)', async () => {
    const days = ['2026-08-01', '2026-08-02', '2026-08-03'];
    const totals = await held(rollupTotalsSql(SEED_SITE, days, 'total', ''), []);
    expect(totals[0]?.index).toBe('rollups_daily_pkey');
    const byDate = await held(rollupTotalsByDateSql(SEED_SITE, days, 'total', ''), []);
    expect(byDate[0]?.index).toBe('rollups_daily_pkey');
    const breakdown = await held(rollupBreakdownSql(SEED_SITE, days, 'page'), []);
    expect(breakdown[0]?.index).toMatch(/^rollup_site_dim_date$|^rollups_daily_pkey$/);
  });

  it('time on page reads the leave beacons of the range and nothing else', async () => {
    const scans = await held(engagementSql(SEED_SITE, week, 'page', false, undefined), SEPTEMBER);
    expect(scans.map((scan) => scan.index)).toEqual(['events_p202609_site_id_type_ts_idx']);
  });

  it('both halves of a conversion walk an index', async () => {
    for (const goal of [signup, pattern]) {
      const totals = await held(conversionTotalsSql(SEED_SITE, week, tz, false, undefined, goal), SEPTEMBER);
      expect(read(totals, 'events_p202609')).toHaveLength(2);
      const rows = await held(
        conversionBreakdownSql(SEED_SITE, week, tz, 'country', false, undefined, goal),
        SEPTEMBER,
      );
      expect(read(rows, 'events_p202609')).toHaveLength(2);
    }
    const stays = await held(
      sessionConversionBreakdownSql(SEED_SITE, week, tz, 'channel', false, undefined, signup),
      SEPTEMBER,
    );
    expect(read(stays, 'sessions')).toHaveLength(1);
    expect(read(stays, 'events_p202609')).toHaveLength(1);
  });

  it('every goal at once is two walks, however many goals', async () => {
    const goals: GoalMatch[] = [
      signup,
      pattern,
      { kind: 'page', match: '/p7' },
      { kind: 'event', match: 'purchase' },
    ];
    const scans = await held(goalStatsSql(SEED_SITE, week, tz, false, undefined, goals), SEPTEMBER);
    expect(read(scans, 'events_p202609')).toHaveLength(2);
  });

  it('the events report and both property reads walk the custom events of the range', async () => {
    const typed = /_site_id_type_ts_idx$/;
    await held(eventsSql(SEED_SITE, week, tz, false, undefined), SEPTEMBER, typed);
    await held(propertyKeysSql(SEED_SITE, week, false, undefined, 'signup'), SEPTEMBER, typed);
    await held(
      propertyValuesSql(SEED_SITE, week, tz, false, undefined, 'signup', 'ab.test'),
      SEPTEMBER,
      typed,
    );
  });

  it("a visitor's profile is their row by its key and their events by (site_id, visitor_id, ts)", async () => {
    const who = { visitorId: 'v10' };
    const row = await held(profileVisitorsSql(SEED_SITE, who), []);
    expect(row.map((scan) => scan.index)).toEqual(['visitors_pkey']);
    for (const statement of [profileSummarySql(SEED_SITE, who), profileEventsSql(SEED_SITE, who)]) {
      // A profile has no range, so it is every month that holds rows, each by
      // the visitor index.
      const scans = await held(statement, EVERY_MONTH, /_site_id_visitor_id_ts_idx$/);
      expect(scans.filter((scan) => !empty.has(scan.relation)).map((scan) => scan.relation).sort()).toEqual(
        EVERY_MONTH,
      );
    }
  });

  it("a user's profile reads the partial user indexes", async () => {
    const who = { userId: 'u20' };
    const rows = await held(profileVisitorsSql(SEED_SITE, who), []);
    expect(rows.map((scan) => scan.index)).toEqual(['visitor_site_user']);
    for (const statement of [profileSummarySql(SEED_SITE, who), profileEventsSql(SEED_SITE, who)]) {
      await held(statement, EVERY_MONTH, /_site_id_user_id_ts_idx$/);
    }
  });

  it('a page of the directory is a walk of (site_id, last_seen_at, id) with no sort', async () => {
    const walk = ['visitor_site_last_seen'];
    const first = await held(peopleSql({ siteId: SEED_SITE, limit: 50 }), []);
    expect(first.map((scan) => [scan.node, scan.index])).toEqual([['Index Scan', walk[0]]]);
    const next = await held(
      peopleSql({
        siteId: SEED_SITE,
        limit: 50,
        after: { lastSeenAt: SEED_NOW - 10 * DAY, visitorId: 'v500' },
      }),
      [],
    );
    expect(next.map((scan) => scan.index)).toEqual(walk);
    const search = await held(peopleSql({ siteId: SEED_SITE, limit: 50, q: 'Person 12' }), []);
    expect(search.map((scan) => scan.index)).toEqual(walk);
    // The identified are a twentieth of this site, so the planner may take
    // their own index and sort a hundred rows instead; either way it is an
    // index and never the table.
    const named = await held(peopleSql({ siteId: SEED_SITE, limit: 50, identifiedOnly: true }), []);
    expect(named[0]?.index).toMatch(/^visitor_site_(last_seen|user)$/);
  });

  it("ingest's one read is two key lookups per visitor", async () => {
    const scans = await held(
      { text: INGEST_READ_SQL, values: [[SEED_SITE, SEED_SITE], ['v10', 'v20']] },
      [],
    );
    expect(scans.map((scan) => scan.index).sort()).toEqual(['session_site_visitor', 'visitors_pkey']);
  });

  it('an identity merge walks one visitor in every month, never a month', async () => {
    // The whole write of a batch that names a visitor for the first time,
    // explained and not run: the two UPDATEs that give the earlier rows the
    // name are what would hurt if they scanned.
    const scans = await scansOf(db.pool, {
      text: ingestWriteSql(true),
      values: [
        '[]',
        '[]',
        '[]',
        JSON.stringify([{ site_id: SEED_SITE, visitor_id: 'v10', user_id: 'u_named' }]),
        ['x20'],
      ],
    });
    const months = scans.filter((scan) => /^events_p/.test(scan.relation) && !empty.has(scan.relation));
    expect(months.map((scan) => scan.relation).sort()).toEqual(EVERY_MONTH);
    for (const scan of months) {
      expect(scan.node).not.toBe('Seq Scan');
      expect(scan.index).toMatch(/_site_id_visitor_id_ts_idx$/);
    }
    const stays = read(scans, 'sessions');
    expect(stays.length).toBeGreaterThan(0);
    for (const scan of stays) {
      expect(scan.node).not.toBe('Seq Scan');
    }
  });

  it('draws no day in SQL: the day lines are the contract own, to the millisecond', async () => {
    // A row one millisecond before the site's midnight and one on it are two
    // days, whatever the server's own time zone is set to.
    const midnight = dayStarts({ from: SEED_NOW - DAY, to: SEED_NOW }, tz)[1]!;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL TIME ZONE 'America/New_York'`);
      await client.query(
        `INSERT INTO events (site_id, ts, received_at, type, visitor_id, bot)
         VALUES ('s_line', $1, $1, 'pageview', 'v_line', false), ('s_line', $2, $2, 'pageview', 'v_line', false)`,
        [midnight - 1, midnight],
      );
      const statement = rawTotalsSql('s_line', { from: midnight - DAY, to: midnight + DAY }, tz, false, undefined);
      const answer = await client.query(statement.text, statement.values);
      // One visitor, on two days of the site's calendar: counted twice.
      const [row] = answer.rows as { visitors: unknown; pageviews: unknown }[];
      expect([Number(row?.visitors), Number(row?.pageviews)]).toEqual([2, 2]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
