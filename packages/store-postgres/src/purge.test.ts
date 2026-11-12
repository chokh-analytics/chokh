import { defaultSiteSettings, type StoredEvent } from '@chokh/store';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { apply } from './migrate.js';
import { dropEmptyPartitionsBefore, listPartitions } from './partitions.js';
import { createPostgresStore, type PostgresStore } from './postgres.store.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';

// What a purge deletes is the conformance suite's to say. These are what it
// cannot see: what becomes of a month once it is empty, and how much a route
// regroup really rewrites.

const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const JUNE = Date.UTC(2026, 5, 10, 9, 0, 0);
const JULY = Date.UTC(2026, 6, 10, 9, 0, 0);
const AUGUST_FIRST = Date.UTC(2026, 7, 1);

function pageview(siteId: string, visitorId: string, ts: number, path: string): StoredEvent {
  return { siteId, ts, receivedAt: ts, type: 'pageview', visitorId, path, bot: false };
}

describe('the months a purge leaves behind', () => {
  let db: TestDatabase;
  let store: PostgresStore;

  const months = async (): Promise<string[]> => (await listPartitions(db.pool)).map((row) => row.name);

  beforeAll(async () => {
    db = await createTestDatabase('purge');
    await apply(db.pool, { now: () => NOW });
    store = await createPostgresStore({ url: db.url, now: () => NOW });
    for (const id of ['s_short', 's_long']) {
      await store.createSite({
        id,
        name: id,
        domains: [`${id}.example`],
        settings: defaultSiteSettings({ visitorIdMode: 'persistent' }),
      });
    }
    await store.ingest([
      pageview('s_short', 'v1', JUNE, '/june'),
      pageview('s_short', 'v1', JULY, '/july'),
      pageview('s_short', 'v2', NOW - 60_000, '/now'),
      // A second site that keeps its rows longer, and has some in July only.
      pageview('s_long', 'v9', JULY + 1000, '/july'),
    ]);
  });

  afterAll(async () => {
    await store.close();
    await db.drop();
  });

  it('drops a month once it is empty, and never one that holds a row of another site', async () => {
    expect(await months()).toEqual(['events_p202606', 'events_p202607', 'events_p202609', 'events_p202610']);

    const purged = await store.purge('s_short', AUGUST_FIRST);
    expect(purged).toEqual({ events: 2, sessions: 2, visitors: 1 });
    // June held only this site's rows and is gone. July still holds the other
    // site's row, which the purge of this site must not touch.
    expect(await months()).toEqual(['events_p202607', 'events_p202609', 'events_p202610']);
    const kept = await db.pool.query<{ site_id: string }>(`SELECT site_id FROM events_p202607`);
    expect(kept.rows).toEqual([{ site_id: 's_long' }]);

    // The other site's own purge empties July, and then July goes too.
    expect((await store.purge('s_long', AUGUST_FIRST)).events).toBe(1);
    expect(await months()).toEqual(['events_p202609', 'events_p202610']);
  });

  it('never drops this month or the next, however empty', async () => {
    // Everything of both sites, to the end of time: the erasure of a site.
    await store.purge('s_short', NOW + 1);
    await store.purge('s_long', NOW + 1);
    const left = await db.pool.query(`SELECT count(*)::int AS n FROM events`);
    expect(left.rows[0]?.n).toBe(0);
    expect(await months()).toEqual(['events_p202609', 'events_p202610']);
  });

  it('writes to a month it dropped as soon as a row needs it again', async () => {
    await store.ingest([pageview('s_short', 'v1', JUNE + 5000, '/june/again')]);
    expect(await months()).toContain('events_p202606');
    const back = await db.pool.query<{ path: string }>(`SELECT path FROM events_p202606`);
    expect(back.rows).toEqual([{ path: '/june/again' }]);
  });

  it('answers its counts and drops nothing while a report is reading, then drops on the next pass', async () => {
    const reader = await db.pool.connect();
    try {
      // A report in flight holds a read lock on events until it ends. The
      // deletes do not need the table to themselves and go through; the drop
      // does, waits half a second and gives up without failing the purge.
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM events');
      const started = Date.now();
      const purged = await store.purge('s_short', AUGUST_FIRST);
      expect(purged.events).toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await months()).toContain('events_p202606');
      await reader.query('COMMIT');
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      reader.release();
    }
    // The next hourly pass finds nothing to delete and the month still empty.
    expect(await store.purge('s_short', AUGUST_FIRST)).toEqual({ events: 0, sessions: 0, visitors: 0 });
    expect(await months()).not.toContain('events_p202606');
  });
});

describe('the tidying after a purge', () => {
  let db: TestDatabase;
  let store: PostgresStore;

  const months = async (): Promise<string[]> => (await listPartitions(db.pool)).map((row) => row.name);

  beforeAll(async () => {
    db = await createTestDatabase('tidying');
    await apply(db.pool, { now: () => NOW });
    // A statement limit shorter than the half second a drop waits for events.
    store = await createPostgresStore({ url: db.url, now: () => NOW, statementTimeoutMs: 150 });
    for (const id of ['s_short', 's_long']) {
      await store.createSite({
        id,
        name: id,
        domains: [`${id}.example`],
        settings: defaultSiteSettings({ visitorIdMode: 'persistent' }),
      });
    }
    await store.ingest([
      pageview('s_short', 'v1', JUNE, '/june'),
      pageview('s_short', 'v1', JULY, '/july'),
      pageview('s_long', 'v9', JUNE + 1000, '/june'),
      pageview('s_long', 'v9', JULY + 1000, '/july'),
    ]);
  });

  afterAll(async () => {
    await store.close();
    await db.drop();
  });

  it('never asks for events to itself while every old month still holds a row', async () => {
    // The usual hour: one site's rows are past its retention, and another
    // site that keeps its rows longer still has some in the same months.
    expect((await store.purge('s_short', AUGUST_FIRST)).events).toBe(2);

    const sent = vi.spyOn(pg.Client.prototype, 'query');
    try {
      expect(await dropEmptyPartitionsBefore(db.pool, AUGUST_FIRST)).toEqual([]);
      const statements = sent.mock.calls.map(([first]) =>
        typeof first === 'string' ? first : String((first as { text?: unknown }).text),
      );
      // It looked at both old months, and took no lock to do it.
      expect(statements.filter((text) => /^SELECT 1 FROM events_p2026\d\d LIMIT 1$/.test(text))).toHaveLength(2);
      expect(statements.filter((text) => /LOCK|BEGIN|DROP/.test(text))).toEqual([]);
    } finally {
      sent.mockRestore();
    }
    expect(await months()).toEqual(['events_p202606', 'events_p202607', 'events_p202609', 'events_p202610']);
  });

  it('is not an error when the statement limit ends the wait for events before the lock timeout does', async () => {
    const reader = await db.pool.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM events');
      // Both old months are emptied by this purge, so the drop does ask for
      // events, behind a report that is reading. At 150 ms the statement limit
      // cancels the wait, long before the lock timeout would have: the purge
      // answers what it deleted all the same, and nothing is dropped.
      const purged = await store.purge('s_long', AUGUST_FIRST);
      expect(purged).toEqual({ events: 2, sessions: 2, visitors: 1 });
      expect(await months()).toEqual(['events_p202606', 'events_p202607', 'events_p202609', 'events_p202610']);
      await reader.query('COMMIT');
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      reader.release();
    }
    // The next hourly pass has the table to itself for the instant it needs.
    expect(await store.purge('s_long', AUGUST_FIRST)).toEqual({ events: 0, sessions: 0, visitors: 0 });
    expect(await months()).toEqual(['events_p202609', 'events_p202610']);
  });

  it('passes over a month another process dropped first', async () => {
    await store.ingest([pageview('s_short', 'v1', JUNE + 9000, '/june/again')]);
    // Two processes run the hourly purge. This one listed the months, and
    // then the other dropped June: stand in for that by answering the list as
    // it was, once, after the table has gone.
    const listed = await listPartitions(db.pool);
    expect(listed.map((row) => row.name)).toContain('events_p202606');
    await db.pool.query('DROP TABLE events_p202606');
    const stale = vi.spyOn(db.pool, 'query');
    stale.mockImplementationOnce((() =>
      Promise.resolve({
        rows: listed.map((row) => ({ name: row.name, bound: `FOR VALUES FROM ('${row.from}') TO ('${row.to}')` })),
        rowCount: listed.length,
      })) as never);
    try {
      expect(await dropEmptyPartitionsBefore(db.pool, AUGUST_FIRST)).toEqual([]);
    } finally {
      stale.mockRestore();
    }
    expect(await months()).toEqual(['events_p202609', 'events_p202610']);
  });
});

describe('a route regroup', () => {
  it('writes only the rows whose route changes, and counts every row it considered', async () => {
    const db = await createTestDatabase('regroup');
    try {
      await apply(db.pool, { now: () => NOW });
      const store = await createPostgresStore({ url: db.url, now: () => NOW });
      try {
        await store.createSite({
          id: 's_routes',
          name: 's_routes',
          domains: ['routes.example'],
          settings: defaultSiteSettings(),
        });
        await store.ingest([
          pageview('s_routes', 'v1', NOW - 5000, '/courses/c'),
          pageview('s_routes', 'v1', NOW - 4000, '/courses/python'),
          pageview('s_routes', 'v1', NOW - 3000, '/pricing'),
          pageview('s_routes', 'v1', NOW - 2000, '/about'),
          { ...pageview('s_routes', 'v1', NOW - 1000, '/'), type: 'identify', path: undefined } as StoredEvent,
        ]);
        // The version of each row before: Postgres stamps every write of a row
        // with the transaction that made it.
        const versions = async (): Promise<Map<string, string>> => {
          const rows = await db.pool.query<{ key: string; version: string; route: string | null }>(
            `SELECT coalesce(path, '(none)') AS key, xmin::text AS version, route FROM events`,
          );
          return new Map(rows.rows.map((row) => [row.key, `${row.version} ${String(row.route)}`]));
        };
        const before = await versions();

        await store.updateSite('s_routes', { settings: { routeGroups: ['/courses/:slug'] } });
        const summary = await store.regroupRoutes('s_routes');
        // Every stored row was considered; today's rows are not re-rolled.
        expect(summary).toEqual({ siteId: 's_routes', events: 5, days: 0 });

        const after = await versions();
        const rewritten = [...after].filter(([key, version]) => before.get(key) !== version);
        expect(rewritten.map(([key]) => key).sort()).toEqual(['/courses/c', '/courses/python']);
        for (const [, version] of rewritten) {
          expect(version.endsWith(' /courses/:slug')).toBe(true);
        }
        // A row with no path has no route before or after, and was not written.
        expect(after.get('(none)')).toBe(before.get('(none)'));
        expect(after.get('(none)')?.endsWith(' null')).toBe(true);

        // Run again with nothing changed, it writes nothing at all.
        await store.regroupRoutes('s_routes');
        expect(await versions()).toEqual(after);
      } finally {
        await store.close();
      }
    } finally {
      await db.drop();
    }
  });
});
