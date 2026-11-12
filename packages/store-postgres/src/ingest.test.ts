import { createMemoryPresence, defaultSiteSettings, type StoredEvent } from '@chokh/store';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { apply } from './migrate.js';
import { listPartitions } from './partitions.js';
import { createPostgresStore, type PostgresStore } from './postgres.store.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';

// What ingest answers is the conformance suite's to say. These are the things
// the suite cannot see: how many times a batch waits on the database, what is
// left behind when a write is refused, and what becomes of a row no partition
// may exist for.

const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const MINUTE = 60_000;
const SITE = 's_ingest';

function pageview(visitorId: string, ts: number, path: string, more: Partial<StoredEvent> = {}): StoredEvent {
  return {
    siteId: SITE,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId,
    path,
    bot: false,
    ...more,
  };
}

describe('ingest', () => {
  let db: TestDatabase;
  let store: PostgresStore;
  const dropped: number[] = [];

  const count = async (table: string, where = 'TRUE'): Promise<number> => {
    const result = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    );
    return result.rows[0]?.n ?? 0;
  };

  beforeAll(async () => {
    db = await createTestDatabase('ingest');
    await apply(db.pool, { now: () => NOW });
    store = await createPostgresStore({
      url: db.url,
      now: () => NOW,
      presence: createMemoryPresence(),
      onOutsideWindow: (n) => dropped.push(n),
    });
    await store.createSite({
      id: SITE,
      name: SITE,
      domains: ['ingest.example'],
      settings: defaultSiteSettings({ visitorIdMode: 'persistent' }),
    });
  });

  afterAll(async () => {
    await store.close();
    await db.drop();
  });

  it('waits on the database twice for a batch, however many visitors it holds', async () => {
    // The first batch pays for what is then remembered: the site row.
    await store.ingest([pageview('v_warm', NOW - 50 * MINUTE, '/')]);

    const queries = vi.spyOn(store.pool, 'query');
    try {
      await store.ingest([
        pageview('v_a', NOW - 9 * MINUTE, '/a'),
        pageview('v_b', NOW - 8 * MINUTE, '/b'),
        pageview('v_a', NOW - 7 * MINUTE, '/a/2'),
        pageview('v_c', NOW - 6 * MINUTE, '/c'),
        { ...pageview('v_c', NOW - 5 * MINUTE, '/c'), type: 'heartbeat' },
      ]);
      // One statement to read every visitor's row and newest stay, one to
      // write everything: no site read, no partition asked for, no
      // transaction opened around either.
      expect(queries).toHaveBeenCalledTimes(2);
      const sent = queries.mock.calls.map((call) => String(call[0]).trim().slice(0, 12));
      expect(sent).toEqual(['SELECT asked', 'WITH stored ']);
    } finally {
      queries.mockRestore();
    }
    // Four stored rows (a heartbeat is never stored), three stays, three people.
    expect(await count('events', `visitor_id IN ('v_a', 'v_b', 'v_c')`)).toBe(4);
    expect(await count('sessions', `visitor_id IN ('v_a', 'v_b', 'v_c')`)).toBe(3);
    expect(await count('visitors', `id IN ('v_a', 'v_b', 'v_c')`)).toBe(3);
  });

  it('stores a good batch around a row of 1970 and a row of 2100, and counts the two', async () => {
    const months = (await listPartitions(db.pool)).map((row) => row.name);
    const before = store.outsideWindow;
    dropped.length = 0;
    await store.ingest([
      pageview('v_good', NOW - 4 * MINUTE, '/one'),
      pageview('v_good', Date.UTC(1970, 0, 2), '/the-epoch'),
      pageview('v_other', NOW - 3 * MINUTE, '/two'),
      pageview('v_good', Date.UTC(2100, 5, 1), '/the-future'),
      // Somebody whose only row is outside the window is nobody.
      pageview('v_ghost', Date.UTC(1970, 0, 3), '/nowhere'),
      pageview('v_good', NOW - 2 * MINUTE, '/three'),
    ]);
    expect(await count('events', `visitor_id IN ('v_good', 'v_other')`)).toBe(3);
    expect(await count('events', `path IN ('/the-epoch', '/the-future', '/nowhere')`)).toBe(0);
    expect(await count('visitors', `id = 'v_ghost'`)).toBe(0);
    expect(await count('sessions', `visitor_id = 'v_ghost'`)).toBe(0);
    // The rows beside them are a stay like any other: three pages, one visit.
    const stay = await db.pool.query(
      `SELECT pageviews, started_at FROM sessions WHERE visitor_id = 'v_good'`,
    );
    expect(stay.rows).toHaveLength(1);
    expect(stay.rows[0]?.pageviews).toBe(2);
    expect(Number(stay.rows[0]?.started_at)).toBe(NOW - 4 * MINUTE);

    expect(dropped).toEqual([3]);
    expect(store.outsideWindow).toBe(before + 3);
    // And no table was made for either year.
    expect((await listPartitions(db.pool)).map((row) => row.name)).toEqual(months);
  });

  it('stores nothing at all for a batch that is wholly outside the window', async () => {
    const queries = vi.spyOn(store.pool, 'query');
    try {
      await store.ingest([pageview('v_past', Date.UTC(1999, 0, 1), '/y2k')]);
      expect(queries).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore();
    }
    expect(await count('events', `visitor_id = 'v_past'`)).toBe(0);
  });

  it('leaves nothing behind when the write is refused: no stay without its events', async () => {
    // A row the table cannot hold, among rows it can. The events, the stays
    // and the visitors are one statement, so none of the three is written.
    const refused = await store
      .ingest([
        pageview('v_whole', NOW - 90 * 1000, '/fine'),
        { ...pageview('v_whole', NOW - 80 * 1000, '/broken'), type: null as unknown as 'pageview' },
        pageview('v_bystander', NOW - 70 * 1000, '/fine-too'),
      ])
      .catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe('23502');
    expect(await count('events', `visitor_id IN ('v_whole', 'v_bystander')`)).toBe(0);
    expect(await count('sessions', `visitor_id IN ('v_whole', 'v_bystander')`)).toBe(0);
    expect(await count('visitors', `id IN ('v_whole', 'v_bystander')`)).toBe(0);
  });

  it('makes a month again when another process dropped it', async () => {
    // Last month: made by this process on the first batch, then dropped from
    // under it, as the retention purge of another process does to a month it
    // has emptied.
    const august = Date.UTC(2026, 7, 20, 9, 0, 0);
    await store.ingest([pageview('v_aug', august, '/august')]);
    expect(await count('events', `visitor_id = 'v_aug'`)).toBe(1);
    await db.pool.query(`DELETE FROM events WHERE visitor_id = 'v_aug'`);
    await db.pool.query('DROP TABLE events_p202608');

    await store.ingest([pageview('v_aug', august + MINUTE, '/august/again')]);
    expect(await count('events', `visitor_id = 'v_aug'`)).toBe(1);
    expect((await listPartitions(db.pool)).map((row) => row.name)).toContain('events_p202608');
  });

  it('stores text Postgres could not hold as it arrived, with the rest of the batch', async () => {
    const nul = String.fromCharCode(0);
    const half = String.fromCharCode(0xdc00);
    await store.ingest([
      pageview('v_text', NOW - 60 * 1000, `/pa${nul}th`, {
        title: `Bro${half}ken ${nul}title`,
        props: { [`ke${nul}y`]: `va${nul}lue` },
        utm: { source: `news${nul}letter` },
      }),
      pageview('v_text', NOW - 50 * 1000, '/সিলেট', { title: 'ঢাকা 😀' }),
    ]);
    const rows = await db.pool.query(
      `SELECT path, title, props, utm_source FROM events WHERE visitor_id = 'v_text' ORDER BY ts`,
    );
    expect(rows.rows).toEqual([
      {
        path: '/path',
        title: `Bro${String.fromCharCode(0xfffd)}ken title`,
        props: { key: 'value' },
        utm_source: 'newsletter',
      },
      { path: '/সিলেট', title: 'ঢাকা 😀', props: null, utm_source: null },
    ]);
  });

  it('finds a name whatever its case, in any script, on a database that folds only ASCII', async () => {
    // The test database is created with the C locale, where lower() in SQL
    // leaves every letter outside ASCII alone. The search does not ask it to.
    await store.ingest([
      pageview('v_named', NOW - 40 * 1000, '/', { userId: 'u_Élodie' }),
      {
        ...pageview('v_named', NOW - 39 * 1000, '/'),
        type: 'identify',
        userId: 'u_Élodie',
        traits: { name: 'ÉLODIE Müller', note: '100% _real_' },
      },
    ]);
    const find = async (q: string): Promise<string[]> =>
      (await store.people({ siteId: SITE, limit: 10, q })).people.map((row) => row.visitorId);
    expect(await find('élodie')).toEqual(['v_named']);
    expect(await find('MÜLLER')).toEqual(['v_named']);
    expect(await find('u_éLODIE')).toEqual(['v_named']);
    // Text, never a pattern: a percent sign and an underscore are themselves.
    expect(await find('100%')).toEqual(['v_named']);
    expect(await find('_real_')).toEqual(['v_named']);
    expect(await find('1%0')).toEqual([]);
    expect(await find('xrealx')).toEqual([]);
  });
});

describe('closing the adapter in the middle of an ingest', () => {
  it('leaves the whole batch or none of it, never a part', async () => {
    const db = await createTestDatabase('ingest_close');
    try {
      await apply(db.pool, { now: () => NOW });
      const outcomes = new Set<string>();
      // Closed at once, and closed a little later, so both sides of the race
      // are tried: before the write was sent, and while it was running.
      for (const delay of [0, 0, 5, 15, 40]) {
        const store = await createPostgresStore({ url: db.url, now: () => NOW });
        await db.pool.query('TRUNCATE events, sessions, visitors, sites, site_domains');
        await store.createSite({
          id: SITE,
          name: SITE,
          domains: ['ingest.example'],
          settings: defaultSiteSettings(),
        });
        const batch = Array.from({ length: 40 }, (_, index) =>
          pageview(`v_${index % 8}`, NOW - (40 - index) * 1000, `/p${index}`),
        );
        const writing = store.ingest(batch).then(
          () => 'stored',
          () => 'refused',
        );
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        await store.close();
        const said = await writing;
        const left = await db.pool.query<{ events: number; stays: number; people: number }>(
          `SELECT (SELECT count(*) FROM events)::int AS events,
                  (SELECT count(*) FROM sessions)::int AS stays,
                  (SELECT count(*) FROM visitors)::int AS people`,
        );
        const found = left.rows[0];
        const whole = found?.events === 40 && found.stays === 8 && found.people === 8;
        const none = found?.events === 0 && found.stays === 0 && found.people === 0;
        expect(whole || none, JSON.stringify(found)).toBe(true);
        // What the caller was told is what happened.
        expect(said).toBe(whole ? 'stored' : 'refused');
        outcomes.add(said);
      }
      expect(outcomes.size).toBeGreaterThan(0);
    } finally {
      await db.drop();
    }
  });
});
