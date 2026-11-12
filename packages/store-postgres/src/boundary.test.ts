import {
  ACTIVITY_WINDOWS,
  DIMENSIONS,
  StoreQueryError,
  defaultSiteSettings,
  type AttributionQuery,
  type CohortQuery,
  type FunnelRead,
  type Goal,
  type Query,
} from '@chokh/store';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { activityFoldSql, funnelFoldSql } from './depth.sql.js';
import { apply } from './migrate.js';
import { createPartition, monthOf } from './partitions.js';
import { createPostgresStore, type PostgresStore } from './postgres.store.js';
import {
  eventKey,
  knownDimension,
  rawBreakdownSql,
  rawTotalsSql,
  sessionKey,
} from './reads.sql.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';

// Nothing a caller names becomes SQL text unchecked.
//
// A value is always a numbered parameter, which the plans and the suite
// already exercise. This is about the names: a dimension chooses a column and
// is written into a breakdown as a literal, an operator chooses a comparison,
// an interval chooses a grouping. The types say each is one of a few words,
// and a caller of a public package has promised nothing of the kind. So each
// read is handed names no type allows, and has to refuse before it sends a
// statement at all.

const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const SITE = 's_boundary';
const range = { siteId: SITE, from: NOW - 86_400_000, to: NOW };

// What a hostile or a careless caller might send where a name belongs.
const HOSTILE: unknown[] = [
  `page'); DROP TABLE events; --`,
  `page" OR ""="`,
  'page; SELECT pg_sleep(10)',
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'Page',
  ' page',
  '',
  42,
  null,
  ['page'],
  { toString: () => 'page' },
];

const CODES = ['UNSUPPORTED_DIMENSION', 'UNSUPPORTED_FILTER', 'UNSUPPORTED_INTERVAL', 'INVALID_GOAL'];

describe('nothing a caller names reaches a statement unchecked', () => {
  let db: TestDatabase;
  let store: PostgresStore;

  beforeAll(async () => {
    db = await createTestDatabase('boundary');
    await apply(db.pool, { now: () => NOW });
    store = await createPostgresStore({ url: db.url, now: () => NOW });
    await store.createSite({
      id: SITE,
      name: SITE,
      domains: ['boundary.example'],
      settings: defaultSiteSettings(),
    });
    // Read once, so a refusal that came after the site lookup would show as a
    // statement too: there is nothing left to cache.
    await store.site(SITE);
  });

  afterAll(async () => {
    await store.close();
    await db.drop();
  });

  // Every read that takes a name, with the hostile value in each place a name
  // goes. `bad` is typed as the thing it stands in for, which is the point.
  type Bad = never;
  const goal = (kind: Bad): Goal =>
    ({ siteId: SITE, id: 'g', name: 'g', kind, match: '/x', createdBy: 'u', createdAt: NOW }) as Goal;
  const families: [string, (bad: Bad) => Promise<unknown>][] = [
    ['aggregate, a filter dimension', (bad) => store.aggregate({ ...range, filters: [{ dim: bad, op: 'is', value: 'x' }] })],
    ['aggregate, a filter operator', (bad) => store.aggregate({ ...range, filters: [{ dim: 'page', op: bad, value: 'x' }] })],
    ['aggregate, a goal kind', (bad) => store.aggregate({ ...range, goal: { kind: bad, match: '/x' } })],
    ['timeseries, the interval', (bad) => store.timeseries({ ...range, interval: bad })],
    ['timeseries, a filter dimension', (bad) => store.timeseries({ ...range, filters: [{ dim: bad, op: 'is', value: 'x' }] })],
    ['breakdown, the dimension', (bad) => store.breakdown({ ...range, dim: bad })],
    ['breakdown, a filter operator', (bad) => store.breakdown({ ...range, dim: 'page', filters: [{ dim: 'country', op: bad, value: 'BD' }] })],
    ['engagement, the dimension', (bad) => store.engagement({ ...range, dim: bad })],
    ['events, a filter dimension', (bad) => store.events({ ...range, filters: [{ dim: bad, op: 'contains', value: 'x' }] })],
    ['properties, a filter operator', (bad) => store.properties({ ...range, event: 'signup', filters: [{ dim: 'page', op: bad, value: 'x' }] })],
    ['goalStats, a filter dimension', (bad) => store.goalStats({ ...range, filters: [{ dim: bad, op: 'is', value: 'x' }] }, [])],
    ['goalStats, a goal kind', (bad) => store.goalStats(range, [goal(bad)])],
    ['funnelStats, a filter dimension', (bad) => store.funnelStats({ ...range, filters: [{ dim: bad, op: 'is', value: 'x' }] }, { window: '1d', steps: [{ kind: 'page', match: '/a' }, { kind: 'page', match: '/b' }] })],
    ['funnelStats, a step kind', (bad) => store.funnelStats(range, { window: '1d', steps: [{ kind: 'page', match: '/a' }, { kind: bad, match: '/b' }] } as FunnelRead)],
    ['journeys, a filter dimension', (bad) => store.journeys({ ...range, filters: [{ dim: bad, op: 'is', value: 'x' }] })],
    ['attribution, the dimension', (bad) => store.attribution({ ...range, goal: { kind: 'event', match: 'signup' }, dim: bad } as AttributionQuery)],
    ['attribution, a goal kind', (bad) => store.attribution({ ...range, goal: { kind: bad, match: 'signup' }, dim: 'channel' })],
    ['cohorts, the interval', (bad) => store.cohorts({ ...range, interval: bad } as CohortQuery)],
  ];

  it.each(families)('%s: refused, and no statement sent', async (_name, run) => {
    const queries = vi.spyOn(store.pool, 'query');
    const connects = vi.spyOn(store.pool, 'connect');
    try {
      for (const bad of HOSTILE) {
        const refused = await run(bad as Bad).then(
          () => 'answered',
          (error: unknown) => error,
        );
        expect(refused, `it answered ${JSON.stringify(bad)}`).toBeInstanceOf(StoreQueryError);
        expect(CODES).toContain((refused as StoreQueryError).code);
        // What was sent is never repeated back.
        expect((refused as StoreQueryError).message).not.toContain('DROP');
      }
      expect(queries).not.toHaveBeenCalled();
      expect(connects).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore();
      connects.mockRestore();
    }
  });

  it('refuses a filter value that is not text, and filters that are not a list', async () => {
    const queries = vi.spyOn(store.pool, 'query');
    try {
      for (const filters of [
        [{ dim: 'page', op: 'is', value: 42 }],
        [{ dim: 'page', op: 'is' }],
        [null],
        'page is x',
        { dim: 'page', op: 'is', value: 'x' },
      ]) {
        const refused = await store
          .aggregate({ ...range, filters } as unknown as Query)
          .catch((error: unknown) => error);
        expect((refused as StoreQueryError).code).toBe('UNSUPPORTED_FILTER');
      }
      expect(queries).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore();
    }
  });

  it('still answers every dimension the contract declares, and the tables are where they were', async () => {
    for (const dim of DIMENSIONS) {
      expect(knownDimension(dim)).toBe(dim);
      const answered = await store.breakdown({ ...range, dim });
      expect(answered.rows).toEqual([]);
      await store.aggregate({ ...range, filters: [{ dim, op: 'is_not', value: `x'; DROP TABLE events; --` }] });
    }
    const left = await db.pool.query(`SELECT to_regclass('events') IS NOT NULL AS there`);
    expect(left.rows[0]?.there).toBe(true);
  });
});

describe('the builders check for themselves', () => {
  const span = { from: NOW - 86_400_000, to: NOW };

  it('look a dimension up as an own entry, so a name every object has is no dimension', () => {
    for (const bad of HOSTILE) {
      expect(() => knownDimension(bad)).toThrow(StoreQueryError);
      expect(() => eventKey(bad as never)).toThrow(StoreQueryError);
      expect(() => sessionKey(bad as never)).toThrow(StoreQueryError);
      expect(() => rawBreakdownSql(SITE, span, 'UTC', [bad as never], false, undefined)).toThrow(
        StoreQueryError,
      );
      expect(() =>
        rawTotalsSql(SITE, span, 'UTC', false, [{ dim: bad as never, op: 'is', value: 'x' }]),
      ).toThrow(StoreQueryError);
      expect(() =>
        rawTotalsSql(SITE, span, 'UTC', false, [{ dim: 'page', op: bad as never, value: 'x' }]),
      ).toThrow(StoreQueryError);
    }
  });

  it('never write a value into the text: a filter value and a site id are parameters', () => {
    const evil = `x'; DROP TABLE events; --`;
    const statement = rawTotalsSql(evil, span, 'UTC', false, [
      { dim: 'page', op: 'is', value: evil },
      { dim: 'entry', op: 'contains', value: evil },
      { dim: 'event', op: 'is_not', value: evil },
    ]);
    expect(statement.text).not.toContain('DROP');
    expect(statement.values.filter((value) => value === evil)).toHaveLength(4);
  });

  it('hold the few numbers and names they do write to their shape', () => {
    expect(() => funnelFoldSql('hits', 3, '$2::bigint', false)).not.toThrow();
    for (const steps of [1, 9, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number]) {
      expect(() => funnelFoldSql('hits', steps, '$2::bigint', false)).toThrow();
    }
    for (const source of ['hits; DROP TABLE events', 'hits h', '', 'Hits', '1hits']) {
      expect(() => funnelFoldSql(source, 3, '$2::bigint', false)).toThrow();
    }
    for (const window of ['60000', '$2', '$2::bigint; DROP TABLE events', '$0::bigint', '$2::int']) {
      expect(() => funnelFoldSql('hits', 3, window, false)).toThrow();
    }

    expect(() => activityFoldSql('seen', '$1::int', ACTIVITY_WINDOWS)).not.toThrow();
    for (const widths of [[0], [1.5], [Number.NaN], [7, -1], [1, 100_000]]) {
      expect(() => activityFoldSql('seen', '$1::int', widths)).toThrow();
    }
    expect(() => activityFoldSql('seen s', '$1::int', [1])).toThrow();
    expect(() => activityFoldSql('seen', '29', [1])).toThrow();
  });

  it('create a partition only for a month, by its own name', async () => {
    // A database that says so if it is asked anything at all.
    const untouched = {
      query: () => {
        throw new Error('a statement was sent');
      },
    } as never;
    const month = monthOf(NOW);
    for (const bad of [
      { ...month, name: 'events_p202609; DROP TABLE events' },
      { ...month, name: 'events' },
      { ...month, name: 'sessions' },
      { ...month, from: Number.NaN },
      { ...month, to: month.from },
      { ...month, from: 1.5 },
      { ...month, to: `${month.to}); DROP TABLE events; --` as unknown as number },
    ]) {
      await expect(createPartition(untouched, bad)).rejects.toThrow(/A partition is a month/);
    }
  });
});
