import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AnalyticsStore } from '../AnalyticsStore.js';
import {
  MAX_HOUR_RANGE_DAYS,
  StoreQueryError,
  type BreakdownResult,
  type Metrics,
} from '../query.js';
import { dayKey } from '../time.js';
import type { Site } from '../types.js';
import * as F from './fixture.js';

export * as fixture from './fixture.js';

// What an adapter hands the suite. addSite and reset live here rather than on
// AnalyticsStore so that seeding a test never widens the production contract.
export interface StoreHarness {
  store: AnalyticsStore;
  addSite(site: Site): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const DAY = 24 * 60 * 60 * 1000;

function rowsByKey(result: BreakdownResult): Map<string, Metrics> {
  return new Map(result.rows.map((row) => [row.key, row.metrics]));
}

// The one suite every adapter passes. A new adapter adds no tests of its own
// for anything covered here.
export function runStoreConformance(name: string, create: () => Promise<StoreHarness>): void {
  describe(`AnalyticsStore conformance: ${name}`, () => {
    let harness: StoreHarness;
    let store: AnalyticsStore;

    const today = { siteId: F.SITE_ID, from: F.TODAY_START, to: F.NOW };
    const yesterday = { siteId: F.SITE_ID, from: F.YESTERDAY_START, to: F.TODAY_START };
    const dayBefore = { siteId: F.SITE_ID, from: F.DAY_BEFORE_START, to: F.YESTERDAY_START };
    const wholeRange = { siteId: F.SITE_ID, from: F.DAY_BEFORE_START, to: F.NOW };

    async function seed(): Promise<void> {
      await harness.reset();
      await harness.addSite(F.fixtureSite());
      await store.ingest(F.fixtureEvents());
      await store.rollupDay(F.SITE_ID, F.DAY_BEFORE);
      await store.rollupDay(F.SITE_ID, F.YESTERDAY);
    }

    beforeAll(async () => {
      harness = await create();
      store = harness.store;
      await seed();
    });

    afterAll(async () => {
      await harness.close();
    });

    describe('site', () => {
      it('answers with the site and its settings', async () => {
        const site = await store.site(F.SITE_ID);
        expect(site).not.toBeNull();
        expect(site?.domains).toEqual(['fixture.test', 'www.fixture.test']);
        expect(site?.settings.timezone).toBe(F.TIMEZONE);
        expect(site?.settings.retentionDays).toBe(F.RETENTION_DAYS);
        expect(site?.settings.ipMode).toBe('full');
        expect(site?.settings.excludeIps).toEqual([]);
        expect(site?.settings.excludePaths).toEqual([]);
        expect(site?.settings.excludeQueryParams).toEqual([]);
      });

      it('answers null for a site nobody registered', async () => {
        expect(await store.site(F.OTHER_SITE_ID)).toBeNull();
      });
    });

    describe('aggregate', () => {
      it('reads today from raw rows', async () => {
        const result = await store.aggregate(today);
        expect(result.metrics.visitors).toBe(F.EXPECTED.today.visitors);
        expect(result.metrics.pageviews).toBe(F.EXPECTED.today.pageviews);
        expect(result.range).toEqual({ from: F.TODAY_START, to: F.NOW });
        expect(result.previous).toBeNull();
        expect(result.previousRange).toBeNull();
      });

      it('reads a past day from the rollup', async () => {
        const result = await store.aggregate(dayBefore);
        expect(result.metrics.visitors).toBe(F.EXPECTED.dayBefore.visitors);
        expect(result.metrics.pageviews).toBe(F.EXPECTED.dayBefore.pageviews);
      });

      it('ends a day at the site midnight, not the UTC one', async () => {
        // BOUNDARY_TS is 18:30 on the 17th in UTC and 00:30 on the 18th in
        // Dhaka. It belongs to today, and yesterday must not have it.
        expect(dayKey(F.BOUNDARY_TS, F.TIMEZONE)).toBe(F.TODAY);
        const before = await store.aggregate(yesterday);
        expect(before.metrics.pageviews).toBe(F.EXPECTED.yesterday.pageviews);

        const utcDay = await store.aggregate({
          siteId: F.SITE_ID,
          from: Date.UTC(2026, 8, 18, 0, 0, 0),
          to: F.NOW,
        });
        expect(utcDay.metrics.pageviews).toBe(F.EXPECTED.today.pageviews - 1);
      });

      it('sums the daily uniques across a range that spans rollups and today', async () => {
        const result = await store.aggregate(wholeRange);
        expect(result.metrics.visitors).toBe(
          F.EXPECTED.dayBefore.visitors + F.EXPECTED.yesterday.visitors + F.EXPECTED.today.visitors,
        );
        expect(result.metrics.pageviews).toBe(
          F.EXPECTED.dayBefore.pageviews +
            F.EXPECTED.yesterday.pageviews +
            F.EXPECTED.today.pageviews,
        );
      });

      it('leaves the session metrics empty until AN-SES01 writes sessions', async () => {
        const result = await store.aggregate(wholeRange);
        expect(result.metrics.visits).toBe(0);
        expect(result.metrics.bounces).toBe(0);
        expect(result.metrics.bounceRate).toBeNull();
        expect(result.metrics.avgDurationMs).toBeNull();
      });

      it('compares against the period before', async () => {
        const result = await store.aggregate({ ...yesterday, compare: 'previous_period' });
        expect(result.previousRange).toEqual({ from: F.DAY_BEFORE_START, to: F.YESTERDAY_START });
        expect(result.previous?.visitors).toBe(F.EXPECTED.dayBefore.visitors);
        expect(result.previous?.pageviews).toBe(F.EXPECTED.dayBefore.pageviews);
      });

      it('compares against the same period a year earlier', async () => {
        const result = await store.aggregate({ ...yesterday, compare: 'previous_year' });
        expect(result.previousRange).not.toBeNull();
        expect(dayKey(result.previousRange?.from ?? 0, F.TIMEZONE)).toBe('2025-09-17');
        expect(result.previous?.pageviews).toBe(0);
      });

      it('refuses a site it does not know', async () => {
        await expect(store.aggregate({ ...today, siteId: F.OTHER_SITE_ID })).rejects.toMatchObject({
          code: 'UNKNOWN_SITE',
        });
      });
    });

    describe('timeseries', () => {
      it('gives one point per day of the site calendar', async () => {
        const result = await store.timeseries({ ...wholeRange, interval: 'day' });
        expect(result.interval).toBe('day');
        expect(result.points.map((point) => point.start)).toEqual([
          F.DAY_BEFORE_START,
          F.YESTERDAY_START,
          F.TODAY_START,
        ]);
        expect(result.points.map((point) => point.metrics.pageviews)).toEqual([
          F.EXPECTED.dayBefore.pageviews,
          F.EXPECTED.yesterday.pageviews,
          F.EXPECTED.today.pageviews,
        ]);
        expect(result.points.map((point) => point.metrics.visitors)).toEqual([
          F.EXPECTED.dayBefore.visitors,
          F.EXPECTED.yesterday.visitors,
          F.EXPECTED.today.visitors,
        ]);
      });

      it('reads raw rows for an hourly series, first hour of the day included', async () => {
        const result = await store.timeseries({ ...today, interval: 'hour' });
        const total = result.points.reduce((sum, point) => sum + point.metrics.pageviews, 0);
        expect(total).toBe(F.EXPECTED.today.pageviews);
        const first = result.points[0];
        expect(first?.start).toBe(F.TODAY_START);
        expect(first?.metrics.pageviews).toBe(1);
      });

      it('refuses an hourly series longer than the cap', async () => {
        const from = F.NOW - (MAX_HOUR_RANGE_DAYS + 1) * DAY;
        const query = { siteId: F.SITE_ID, from, to: F.NOW, interval: 'hour' } as const;
        await expect(store.timeseries(query)).rejects.toBeInstanceOf(StoreQueryError);
        await expect(store.timeseries(query)).rejects.toMatchObject({ code: 'RANGE_TOO_LONG' });
      });

      it('starts a week on Monday', async () => {
        const result = await store.timeseries({ ...wholeRange, interval: 'week' });
        // The fixture is a Wednesday, a Thursday and a Friday, so one week.
        expect(result.points).toHaveLength(1);
        expect(dayKey(result.points[0]?.start ?? 0, F.TIMEZONE)).toBe('2026-09-14');
        expect(result.points[0]?.metrics.pageviews).toBe(
          F.EXPECTED.dayBefore.pageviews +
            F.EXPECTED.yesterday.pageviews +
            F.EXPECTED.today.pageviews,
        );
      });

      it('gives one point for the month', async () => {
        const result = await store.timeseries({ ...wholeRange, interval: 'month' });
        expect(result.points).toHaveLength(1);
        expect(dayKey(result.points[0]?.start ?? 0, F.TIMEZONE)).toBe('2026-09-01');
      });

      it('carries a comparison series when asked', async () => {
        const result = await store.timeseries({
          ...yesterday,
          interval: 'day',
          compare: 'previous_period',
        });
        expect(result.previous).not.toBeNull();
        expect(result.previous?.[0]?.metrics.pageviews).toBe(F.EXPECTED.dayBefore.pageviews);
      });
    });

    describe('breakdown', () => {
      it('breaks today down by page', async () => {
        const rows = rowsByKey(await store.breakdown({ ...today, dim: 'page' }));
        expect(rows.get('/home')?.pageviews).toBe(1);
        expect(rows.get('/pricing')?.pageviews).toBe(1);
        expect(rows.get('/docs')?.pageviews).toBe(1);
      });

      it('breaks the whole range down by page, rollups and today together', async () => {
        const result = await store.breakdown({ ...wholeRange, dim: 'page' });
        const rows = rowsByKey(result);
        expect(rows.get('/home')?.pageviews).toBe(5);
        expect(rows.get('/home')?.visitors).toBe(5);
        expect(rows.get('/pricing')?.pageviews).toBe(2);
        expect(rows.get('/docs')?.pageviews).toBe(2);
        expect(result.rows[0]?.key).toBe('/home');
      });

      it('honours the limit', async () => {
        const result = await store.breakdown({ ...wholeRange, dim: 'page', limit: 2 });
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]?.key).toBe('/home');
      });

      it('breaks down by the dimensions an event carries', async () => {
        const country = rowsByKey(await store.breakdown({ ...today, dim: 'country' }));
        expect(country.get('BD')?.visitors).toBe(2);
        expect(country.get('IN')?.visitors).toBe(1);

        const city = rowsByKey(await store.breakdown({ ...today, dim: 'city' }));
        expect(city.get('Dhaka')?.visitors).toBe(1);
        expect(city.get('Chattogram')?.visitors).toBe(1);

        const browser = rowsByKey(await store.breakdown({ ...today, dim: 'browser' }));
        expect(browser.get('Chrome')?.visitors).toBe(1);
        expect(browser.get('Edge')?.visitors).toBe(1);

        const device = rowsByKey(await store.breakdown({ ...today, dim: 'device' }));
        expect(device.get('mobile')?.visitors).toBe(2);
        expect(device.get('desktop')?.visitors).toBe(1);

        const lang = rowsByKey(await store.breakdown({ ...today, dim: 'lang' }));
        expect(lang.get('bn')?.visitors).toBe(2);

        const referrer = rowsByKey(await store.breakdown({ ...wholeRange, dim: 'referrer' }));
        expect(referrer.get('https://www.facebook.com/')?.visitors).toBe(1);
        expect(referrer.get('https://www.google.com/')?.visitors).toBe(1);

        const utm = rowsByKey(await store.breakdown({ ...wholeRange, dim: 'utm_source' }));
        expect(utm.get('facebook')?.visitors).toBe(1);

        const events = rowsByKey(await store.breakdown({ ...today, dim: 'event' }));
        expect(events.get('signup')?.visitors).toBe(1);
        expect(events.size).toBe(1);
      });

      it('answers nothing for the dimensions a session carries, until AN-SES01', async () => {
        for (const dim of ['entry', 'exit', 'channel'] as const) {
          const result = await store.breakdown({ ...wholeRange, dim });
          expect(result.dim).toBe(dim);
          expect(result.rows).toEqual([]);
        }
      });
    });

    describe('filters', () => {
      it('narrows to one value', async () => {
        const result = await store.aggregate({
          ...today,
          filters: [{ dim: 'page', op: 'is', value: '/docs' }],
        });
        expect(result.metrics.visitors).toBe(1);
        expect(result.metrics.pageviews).toBe(1);
      });

      it('excludes one value', async () => {
        const result = await store.aggregate({
          ...today,
          filters: [{ dim: 'page', op: 'is_not', value: '/docs' }],
        });
        expect(result.metrics.pageviews).toBe(2);
      });

      it('matches part of a value', async () => {
        const result = await store.aggregate({
          ...today,
          filters: [{ dim: 'page', op: 'contains', value: 'ric' }],
        });
        expect(result.metrics.pageviews).toBe(1);
      });

      it('reads across rollups and today by falling back to raw rows', async () => {
        const result = await store.aggregate({
          ...wholeRange,
          filters: [{ dim: 'country', op: 'is', value: 'BD' }],
        });
        // v1 viewed four pages and v3 three, and the daily uniques are 1 on
        // the 16th, then 2 and 2.
        expect(result.metrics.pageviews).toBe(7);
        expect(result.metrics.visitors).toBe(5);
      });

      it('leaves bots out unless the query asks for them', async () => {
        const without = await store.aggregate(today);
        expect(without.metrics.pageviews).toBe(F.EXPECTED.today.pageviews);

        const bots = await store.aggregate({
          ...today,
          filters: [{ dim: 'bot', op: 'is', value: 'true' }],
        });
        expect(bots.metrics.visitors).toBe(1);
        expect(bots.metrics.pageviews).toBe(1);
      });

      it('counts the bot share of a rolled up day too', async () => {
        const bots = await store.aggregate({
          ...wholeRange,
          filters: [{ dim: 'bot', op: 'is', value: 'true' }],
        });
        expect(bots.metrics.pageviews).toBe(1);
      });

      it('narrows a breakdown as well', async () => {
        const rows = rowsByKey(
          await store.breakdown({
            ...wholeRange,
            dim: 'page',
            filters: [{ dim: 'country', op: 'is', value: 'IN' }],
          }),
        );
        expect(rows.get('/home')?.pageviews).toBe(1);
        expect(rows.get('/pricing')?.pageviews).toBe(1);
        expect(rows.has('/docs')).toBe(false);
      });
    });

    describe('realtime', () => {
      it('counts only the last minute', async () => {
        const snapshot = await store.realtime(F.SITE_ID);
        expect(snapshot.online).toBe(1);
        expect(snapshot.anonymous).toBe(1);
        expect(snapshot.signedIn).toBe(0);
        expect(snapshot.byPage).toEqual([{ key: '/pricing', visitors: 1 }]);
        expect(snapshot.byCountry).toEqual([{ key: 'IN', visitors: 1 }]);
      });

      it('says who they are and how long they have been here', async () => {
        const snapshot = await store.realtime(F.SITE_ID);
        const visitor = snapshot.visitors[0];
        expect(visitor?.visitorId).toBe('v2');
        expect(visitor?.path).toBe('/pricing');
        expect(visitor?.country).toBe('IN');
        expect(visitor?.city).toBe('Kolkata');
        expect(visitor?.browser).toBe('Edge');
        expect(visitor?.device).toBe('desktop');
        expect(visitor?.ip).toBe('49.37.200.4');
        expect(visitor?.lastSeenAt).toBe(F.NOW - 30_000);
        expect(visitor?.since).toBe(F.NOW - 600_000);
      });
    });

    describe('visitor and user', () => {
      it('profiles a visitor from their events', async () => {
        const profile = await store.visitor(F.SITE_ID, 'v1');
        expect(profile).not.toBeNull();
        expect(profile?.userId).toBe('u_rafi');
        expect(profile?.traits).toEqual({ plan: 'pro' });
        expect(profile?.firstSeenAt).toBe(Date.UTC(2026, 8, 16, 3, 0, 0));
        expect(profile?.lastSeenAt).toBe(Date.UTC(2026, 8, 18, 3, 50, 0));
        expect(profile?.pageviews).toBe(4);
        expect(profile?.events).toBe(1);
        expect(profile?.sessions).toBe(0);
        expect(profile?.homeGeo?.city).toBe('Dhaka');
        expect(profile?.devices).toEqual(['Chrome on Android']);
        expect(profile?.ips).toEqual(['103.87.12.9']);
        expect(profile?.timeline.length).toBeGreaterThan(0);
        expect(profile?.timeline[0]?.ts).toBe(Date.UTC(2026, 8, 18, 3, 50, 0));
      });

      it('answers null for a visitor nobody has seen', async () => {
        expect(await store.visitor(F.SITE_ID, 'nobody')).toBeNull();
      });

      it('profiles an identified person by their user id', async () => {
        const profile = await store.user(F.SITE_ID, 'u_rafi');
        expect(profile).not.toBeNull();
        expect(profile?.userId).toBe('u_rafi');
        expect(profile?.visitorIds).toEqual(['v1']);
        expect(profile?.pageviews).toBe(4);
      });

      it('answers null for a user nobody has identified', async () => {
        expect(await store.user(F.SITE_ID, 'nobody')).toBeNull();
      });
    });

    describe('rollupDay', () => {
      it('writes the same numbers when it runs twice', async () => {
        const first = await store.rollupDay(F.SITE_ID, F.YESTERDAY);
        const second = await store.rollupDay(F.SITE_ID, F.YESTERDAY);
        expect(second).toEqual(first);
        expect(first.visitors).toBe(F.EXPECTED.yesterday.visitors);
        expect(first.pageviews).toBe(F.EXPECTED.yesterday.pageviews);

        const after = await store.aggregate(yesterday);
        expect(after.metrics.pageviews).toBe(F.EXPECTED.yesterday.pageviews);
      });

      it('reports a day nobody visited without inventing rows', async () => {
        const summary = await store.rollupDay(F.SITE_ID, '2026-01-01');
        expect(summary.visitors).toBe(0);
        expect(summary.pageviews).toBe(0);
        expect(summary.rows).toBe(0);
      });
    });

    describe('purge', () => {
      beforeAll(async () => {
        await seed();
      });

      it('deletes raw rows before the instant and leaves the rollups alone', async () => {
        const summary = await store.purge(F.SITE_ID, F.YESTERDAY_START);
        expect(summary.events).toBe(3);
        expect(summary.sessions).toBe(0);

        // The raw rows of that day are gone, so a filtered read finds nothing.
        const filtered = await store.aggregate({
          ...dayBefore,
          filters: [{ dim: 'page', op: 'is', value: '/home' }],
        });
        expect(filtered.metrics.pageviews).toBe(0);

        // The rolled up history survives, which is the point of rolling up.
        const rolled = await store.aggregate(dayBefore);
        expect(rolled.metrics.pageviews).toBe(F.EXPECTED.dayBefore.pageviews);

        // Today is untouched.
        const untouched = await store.aggregate(today);
        expect(untouched.metrics.pageviews).toBe(F.EXPECTED.today.pageviews);
      });
    });
  });
}
