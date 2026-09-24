import { fixture } from '@chokh/store/conformance';
import { defaultSiteSettings, type Site, type StoredEvent } from '@chokh/store';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';
import { ROLLUP_BACKFILL_DAYS, rollableDays, runJobsOnce } from './jobs.js';

const DAY = 24 * 60 * 60 * 1000;

function site(over: Partial<Site['settings']> = {}, id = 'site_1'): Site {
  return {
    id,
    name: 'Fixture',
    domains: ['fixture.test'],
    settings: defaultSiteSettings({ timezone: 'Asia/Dhaka', retentionDays: 30, ...over }),
  };
}

const silent = { info: (): void => undefined, warn: (): void => undefined };

describe('which days a site may be rolled for', () => {
  it('rolls yesterday in the site calendar, not in UTC', () => {
    // 19:00Z on the 17th is already 01:00 on the 18th in Dhaka, so Dhaka's
    // yesterday is the 17th while UTC's is still the 16th.
    const at = Date.UTC(2026, 8, 17, 19, 0, 0);
    expect(rollableDays(site(), at, 1)).toEqual(['2026-09-17']);
    expect(rollableDays(site({ timezone: 'UTC' }), at, 1)).toEqual(['2026-09-16']);
  });

  it('never reaches a day whose raw rows have begun to expire', () => {
    // Retention of three days means yesterday and the day before it, and no
    // further: re-rolling a day that has lost rows would overwrite a good
    // rollup with a smaller one, and the rollup is the only copy left.
    const at = Date.UTC(2026, 8, 18, 4, 0, 0);
    expect(rollableDays(site({ retentionDays: 3 }), at, ROLLUP_BACKFILL_DAYS)).toEqual([
      '2026-09-17',
      '2026-09-16',
    ]);
  });

  it('never rolls today, because today is not over', () => {
    const at = Date.UTC(2026, 8, 18, 4, 0, 0);
    expect(rollableDays(site(), at, ROLLUP_BACKFILL_DAYS)).not.toContain('2026-09-18');
  });

  it('reaches back a week on the first pass and one day after that', () => {
    const at = Date.UTC(2026, 8, 18, 4, 0, 0);
    expect(rollableDays(site(), at, ROLLUP_BACKFILL_DAYS)).toHaveLength(ROLLUP_BACKFILL_DAYS);
    expect(rollableDays(site(), at, 1)).toEqual(['2026-09-17']);
  });

  it('reaches as far back as the backfill asks when the site keeps rows forever', () => {
    const at = Date.UTC(2026, 8, 18, 4, 0, 0);
    expect(rollableDays(site({ retentionDays: 0 }), at, 3)).toEqual([
      '2026-09-17',
      '2026-09-16',
      '2026-09-15',
    ]);
  });
});

describe('the hourly pass', () => {
  let store: MemoryStore;
  const deps = (): Parameters<typeof runJobsOnce>[0] => ({
    store,
    log: silent,
    now: () => fixture.NOW,
  });

  beforeEach(async () => {
    store = createMemoryStore([], { now: () => fixture.NOW });
    await store.createSite(fixture.fixtureSite());
    await store.ingest(fixture.fixtureEvents());
  });

  it('reads the same numbers when it runs twice', async () => {
    const range = { siteId: fixture.SITE_ID, from: fixture.DAY_BEFORE_START, to: fixture.NOW };
    await runJobsOnce(deps(), ROLLUP_BACKFILL_DAYS);
    const first = await store.aggregate(range);
    await runJobsOnce(deps(), ROLLUP_BACKFILL_DAYS);
    const second = await store.aggregate(range);
    expect(second).toEqual(first);
    expect(first.metrics.pageviews).toBe(fixture.EXPECTED_RANGE.pageviews);
    expect(first.metrics.visits).toBe(fixture.EXPECTED_RANGE.visits);
  });

  it('is what puts yesterday into the rollups in the first place', async () => {
    const yesterday = {
      siteId: fixture.SITE_ID,
      from: fixture.YESTERDAY_START,
      to: fixture.TODAY_START,
    };
    // Nothing has been rolled yet, and a whole past day is read from rollups.
    expect((await store.aggregate(yesterday)).metrics.pageviews).toBe(0);
    await runJobsOnce(deps(), ROLLUP_BACKFILL_DAYS);
    expect((await store.aggregate(yesterday)).metrics.pageviews).toBe(
      fixture.EXPECTED.yesterday.pageviews,
    );
    expect((await store.aggregate(yesterday)).metrics.visits).toBe(
      fixture.EXPECTED.yesterday.visits,
    );
  });

  it('regroups the routes of a site whose rules changed, then takes the mark off', async () => {
    await runJobsOnce(deps(), ROLLUP_BACKFILL_DAYS);
    await store.updateSite(fixture.SITE_ID, { settings: { routeGroups: ['/:page'] } });
    expect((await store.site(fixture.SITE_ID))?.routesChangedAt).toBe(fixture.NOW);

    await runJobsOnce(deps(), 1);
    expect((await store.site(fixture.SITE_ID))?.routesChangedAt).toBeUndefined();
    const rolled = await store.breakdown({
      siteId: fixture.SITE_ID,
      from: fixture.YESTERDAY_START,
      to: fixture.TODAY_START,
      dim: 'route',
    });
    expect(rolled.rows.map((row) => row.key)).toEqual(['/:page']);
    expect(rolled.rows[0]?.metrics.pageviews).toBe(fixture.EXPECTED.yesterday.pageviews);
  });

  it('takes away the detail the site retention no longer covers', async () => {
    const short = createMemoryStore([site({ retentionDays: 2, timezone: 'UTC' })], {
      now: () => fixture.NOW,
    });
    const event = (ts: number): StoredEvent => ({
      siteId: 'site_1',
      ts,
      receivedAt: ts,
      type: 'pageview',
      visitorId: 'v1',
      path: '/home',
      bot: false,
    });
    await short.ingest([event(fixture.NOW - 10 * DAY)]);
    await short.ingest([event(fixture.NOW - 60_000)]);
    expect(short.stored()).toHaveLength(2);

    await runJobsOnce({ store: short, log: silent, now: () => fixture.NOW }, 1);
    expect(short.stored().map((row) => row.ts)).toEqual([fixture.NOW - 60_000]);
    // The stay that ended ten days ago goes with its events.
    expect(short.sessionsOf('site_1', 'v1')).toHaveLength(1);
  });

  it('leaves a site that keeps its rows forever alone', async () => {
    const forever = createMemoryStore([site({ retentionDays: 0 })], { now: () => fixture.NOW });
    await forever.ingest([
      {
        siteId: 'site_1',
        ts: fixture.NOW - 400 * DAY,
        receivedAt: fixture.NOW - 400 * DAY,
        type: 'pageview',
        visitorId: 'v1',
        path: '/home',
        bot: false,
      },
    ]);
    await runJobsOnce({ store: forever, log: silent, now: () => fixture.NOW }, 1);
    expect(forever.stored()).toHaveLength(1);
  });

  it('carries on to the next site when one of them fails', async () => {
    const warnings: string[] = [];
    const broken: Parameters<typeof runJobsOnce>[0] = {
      store: {
        ...store,
        // The broken one goes first, so a pass that gave up on the first
        // failure would leave the real site unrolled and this test red.
        sites: () => Promise.resolve([site({}, 'site_missing'), fixture.fixtureSite()]),
      },
      log: { info: () => undefined, warn: (_details, message) => warnings.push(message) },
      now: () => fixture.NOW,
    };
    await runJobsOnce(broken, 1);
    expect(warnings).toContain('rollup failed');
    expect(
      (
        await store.aggregate({
          siteId: fixture.SITE_ID,
          from: fixture.YESTERDAY_START,
          to: fixture.TODAY_START,
        })
      ).metrics.pageviews,
    ).toBe(fixture.EXPECTED.yesterday.pageviews);
  });
});
