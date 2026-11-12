import { defaultSiteSettings, type StoredEvent } from '@chokh/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apply } from './migrate.js';
import { listPartitions } from './partitions.js';
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
