import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apply } from './migrate.js';
import {
  PARTITION_FLOOR_DAYS,
  createPartitionManager,
  inPartitionWindow,
  listPartitions,
  monthOf,
  monthsFor,
  partitionWindow,
} from './partitions.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const now = (): number => NOW;

const YEAR_1970 = Date.UTC(1970, 0, 2);
const YEAR_2100 = Date.UTC(2100, 5, 1);

describe('the month a row belongs to', () => {
  it('is the calendar month of UTC, first instant in and last instant out', () => {
    const month = monthOf(Date.UTC(2026, 8, 18, 4));
    expect(month).toEqual({
      name: 'events_p202609',
      from: Date.UTC(2026, 8, 1),
      to: Date.UTC(2026, 9, 1),
    });
    expect(monthOf(month.from).name).toBe('events_p202609');
    expect(monthOf(month.to - 1).name).toBe('events_p202609');
    expect(monthOf(month.to).name).toBe('events_p202610');
    expect(monthOf(Date.UTC(2026, 11, 31, 23, 59, 59, 999)).name).toBe('events_p202612');
    expect(monthOf(Date.UTC(2027, 0, 1)).name).toBe('events_p202701');
  });
});

describe('the window a partition may exist in', () => {
  it('runs from the month the retention ceiling falls in to the end of next month', () => {
    const window = partitionWindow(NOW);
    expect(window.to).toBe(Date.UTC(2026, 10, 1));
    expect(window.from).toBe(monthOf(NOW - PARTITION_FLOOR_DAYS * DAY).from);
    expect(inPartitionWindow(NOW, NOW)).toBe(true);
    expect(inPartitionWindow(window.from, NOW)).toBe(true);
    expect(inPartitionWindow(window.from - 1, NOW)).toBe(false);
    expect(inPartitionWindow(window.to - 1, NOW)).toBe(true);
    expect(inPartitionWindow(window.to, NOW)).toBe(false);
  });

  it('has no place for a row of 1970, of 2100, or of no instant at all', () => {
    expect(inPartitionWindow(YEAR_1970, NOW)).toBe(false);
    expect(inPartitionWindow(YEAR_2100, NOW)).toBe(false);
    expect(inPartitionWindow(Number.NaN, NOW)).toBe(false);
    expect(inPartitionWindow(Number.POSITIVE_INFINITY, NOW)).toBe(false);
    expect(monthsFor([YEAR_1970, NOW, YEAR_2100, NOW + 1], NOW).map((month) => month.name)).toEqual([
      'events_p202609',
    ]);
  });

  it('never holds more than 122 months, whenever now is', () => {
    let most = 0;
    // Every day of twelve years, so every length of month and both kinds of
    // year have been the current one.
    for (let at = Date.UTC(2024, 0, 1); at < Date.UTC(2036, 0, 1); at += DAY) {
      const window = partitionWindow(at);
      let months = 0;
      for (let cursor = window.from; cursor < window.to; cursor = monthOf(cursor).to) {
        months += 1;
      }
      most = Math.max(most, months);
    }
    expect(most).toBe(122);
  });
});

describe('partitions in the database', () => {
  let db: TestDatabase;

  const insert = (
    target: { query: PoolClient['query'] },
    ts: number,
    visitor = 'v1',
  ): Promise<unknown> =>
    target.query(
      `INSERT INTO events (site_id, ts, received_at, type, visitor_id, bot)
       VALUES ('s1', $1, $1, 'pageview', $2, false)`,
      [ts, visitor],
    );

  beforeAll(async () => {
    db = await createTestDatabase('partitions');
    await apply(db.pool, { now });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('refuses a row whose month has no partition, with the code ingest retries on', async () => {
    const refused = await insert(db.pool, Date.UTC(2026, 5, 10)).catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe('23514');
  });

  it('makes a month the first time it is needed and asks nothing after that', async () => {
    const manager = createPartitionManager(db.pool, now);
    const june = Date.UTC(2026, 5, 10);
    expect(await manager.ensure([june, june + DAY, NOW])).toEqual(['events_p202606']);
    await insert(db.pool, june);
    const where = await db.pool.query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM events WHERE ts = $1`,
      [june],
    );
    expect(where.rows[0]?.part).toBe('events_p202606');
    expect((await listPartitions(db.pool)).map((row) => row.name)).toEqual([
      'events_p202606',
      'events_p202609',
      'events_p202610',
    ]);

    // The second time it is a lookup in a set: no connection is taken at all.
    const before = db.pool.totalCount;
    let connects = 0;
    const count = (): void => {
      connects += 1;
    };
    db.pool.on('acquire', count);
    expect(await manager.ensure([june])).toEqual([]);
    db.pool.off('acquire', count);
    expect(connects).toBe(0);
    expect(db.pool.totalCount).toBe(before);
  });

  it('gives the new month every index of its parent', async () => {
    const indexes = await db.pool.query<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'events_p202606'`,
    );
    // Sorted here, not by the database, whose own order follows its locale.
    const keys = indexes.rows.map((row) => /\((.*)\)/.exec(row.definition)?.[1]).sort();
    expect(keys).toEqual([
      'site_id, ts',
      'site_id, type, ts',
      'site_id, user_id, ts) WHERE (user_id IS NOT NULL',
      'site_id, visitor_id, ts',
    ]);
  });

  it('keeps the columns a report groups by from the documents the row carries', async () => {
    // One row in a month migrate made and one in a month the manager made:
    // both partitions have to carry the generated columns of their parent.
    for (const ts of [NOW, Date.UTC(2026, 5, 11)]) {
      await db.pool.query(
        `INSERT INTO events (site_id, ts, received_at, type, visitor_id, bot, utm, geo, ua)
         VALUES ('s_gen', $1, $1, 'pageview', 'v9', false, $2, $3, $4)`,
        [
          ts,
          JSON.stringify({ source: 'facebook', campaign: 'imupc' }),
          JSON.stringify({ country: 'BD', city: 'সিলেট', lat: 24.9, lon: 91.87 }),
          JSON.stringify({ browser: 'Firefox', os: 'Linux', device: 'desktop' }),
        ],
      );
    }
    const rows = await db.pool.query(
      `SELECT utm_source, utm_medium, utm_campaign, country, region, city, browser, os, device
         FROM events WHERE site_id = 's_gen' ORDER BY ts`,
    );
    const expected = {
      utm_source: 'facebook',
      utm_medium: null,
      utm_campaign: 'imupc',
      country: 'BD',
      region: null,
      city: 'সিলেট',
      browser: 'Firefox',
      os: 'Linux',
      device: 'desktop',
    };
    expect(rows.rows).toEqual([expected, expected]);
    // And nobody can write one by hand and make it disagree.
    const forged = await db.pool
      .query(
        `INSERT INTO events (site_id, ts, received_at, type, visitor_id, bot, country)
         VALUES ('s_gen', $1, $1, 'pageview', 'v9', false, 'XX')`,
        [NOW],
      )
      .catch((error: unknown) => error);
    expect((forged as { code?: string }).code).toBe('428C9');
  });

  it('finds a month another process already made', async () => {
    // A second manager is a second process: it has seen nothing yet.
    const other = createPartitionManager(db.pool, now);
    expect(await other.ensure([Date.UTC(2026, 5, 20)])).toEqual([]);
  });

  it('makes a month once when two processes meet its first batch together', async () => {
    const july = Date.UTC(2026, 6, 4);
    const made = await Promise.all(
      [1, 2, 3, 4].map(() => createPartitionManager(db.pool, now).ensure([july])),
    );
    expect(made.flat()).toEqual(['events_p202607']);
  });

  it('makes nothing for a row outside the window, and still makes the months beside it', async () => {
    const manager = createPartitionManager(db.pool, now);
    const before = (await listPartitions(db.pool)).length;
    expect(await manager.ensure([YEAR_1970, YEAR_2100])).toEqual([]);
    expect(await manager.ensure([YEAR_1970, Date.UTC(2026, 7, 9), YEAR_2100])).toEqual([
      'events_p202608',
    ]);
    const names = (await listPartitions(db.pool)).map((row) => row.name);
    expect(names).toHaveLength(before + 1);
    expect(names.some((name) => name.startsWith('events_p1970'))).toBe(false);
    expect(names.some((name) => name.startsWith('events_p2100'))).toBe(false);
  });

  it('asks the database again once it is told to forget', async () => {
    const manager = createPartitionManager(db.pool, now);
    const may = Date.UTC(2026, 4, 3);
    expect(await manager.ensure([may])).toEqual(['events_p202605']);
    // Somebody else drops it, as the retention purge does to an emptied month.
    await db.pool.query('DROP TABLE events_p202605');
    expect(await manager.ensure([may])).toEqual([]);
    manager.forget();
    expect(await manager.ensure([may])).toEqual(['events_p202605']);
  });

  it('is not stalled by a report held open on events, and does not stall a write', async () => {
    const reader = await db.pool.connect();
    const blocked = await db.pool.connect();
    try {
      // A report in flight: its transaction holds a read lock on events until
      // it ends, which is as long as the slowest query on the dashboard.
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM events');

      // What this adapter does not do, to show the lock is real: the plain
      // statement needs the parent to itself and cannot have it.
      await blocked.query(`SET lock_timeout = '300ms'`);
      const plain = await blocked
        .query(
          `CREATE TABLE events_p202601 PARTITION OF events
             FOR VALUES FROM (${Date.UTC(2026, 0, 1)}) TO (${Date.UTC(2026, 1, 1)})`,
        )
        .catch((error: unknown) => error);
      expect((plain as { code?: string }).code).toBe('55P03');

      // What it does: a table made beside the parent and attached.
      const manager = createPartitionManager(db.pool, now);
      const april = Date.UTC(2026, 3, 7);
      const started = Date.now();
      expect(await manager.ensure([april])).toEqual(['events_p202604']);
      await insert(db.pool, april, 'v2');
      expect(Date.now() - started).toBeLessThan(10_000);

      // The report is still open, and reads on undisturbed.
      const still = await reader.query<{ n: string }>('SELECT count(*) AS n FROM events');
      expect(Number(still.rows[0]?.n)).toBeGreaterThan(0);
      await reader.query('COMMIT');
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      await blocked.query('RESET lock_timeout').catch(() => undefined);
      reader.release();
      blocked.release();
    }
  });
});
