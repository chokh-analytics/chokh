import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  NOW,
  SITE_ID,
  type Harness,
} from './api.test-utils.js';
import type { Metrics, StoredEvent } from '../store/AnalyticsStore.js';

// The three reports and the CSV export, over HTTP.
//
// The site is in UTC, so the numbers here can be read off the clock: today began at
// TODAY_START and the events below are all in the eleventh hour.

const TODAY_START = Date.UTC(2026, 8, 18);
const TOMORROW = Date.UTC(2026, 8, 19);
const YESTERDAY_START = Date.UTC(2026, 8, 17);
const HOUR = 60 * 60 * 1000;

function pageview(visitorId: string, path: string, ts: number): StoredEvent {
  return {
    siteId: SITE_ID,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId,
    path,
    hostname: 'test.example',
    bot: false,
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country: 'BD', city: 'Dhaka' },
    lang: 'en',
  };
}

describe('the reports', () => {
  let harness: Harness;
  let read: string;

  beforeAll(async () => {
    harness = await createHarness();
    read = harness.owner.cookie;

    // Two visitors today. One read two pages, one read one and left, which makes
    // exactly one bounce out of two visits.
    await harness.store.ingest([
      pageview('v_1', '/pricing', NOW - HOUR),
      pageview('v_1', '/', NOW - 50 * 60_000),
      pageview('v_2', '/pricing', NOW - 30 * 60_000),
      {
        siteId: SITE_ID,
        ts: NOW - 29 * 60_000,
        receivedAt: NOW - 29 * 60_000,
        type: 'leave',
        visitorId: 'v_2',
        path: '/pricing',
        bot: false,
        // What the leave beacon is for: the time on this page and how far down
        // it they got. Nothing else in the store records either.
        duration: 62_000,
        scrollDepth: 75,
      },
    ]);
    // One visitor yesterday, rolled up, so a range that spans both reads history
    // from the rollup and today from raw rows.
    await harness.store.ingest([pageview('v_3', '/', YESTERDAY_START + 12 * HOUR)]);
    await harness.store.rollupDay(SITE_ID, '2026-09-17');
  });

  afterAll(async () => {
    await harness.close();
  });

  function get(path: string, headers: Record<string, string> = { cookie: read }) {
    return harness.app.inject({ method: 'GET', url: path, headers });
  }

  const today = `from=${TODAY_START}&to=${NOW}`;

  describe('aggregate', () => {
    it('answers the totals of the range with the envelope and a meta', async () => {
      const response = await get(`/api/sites/${SITE_ID}/stats/aggregate?${today}`);
      expect(response.statusCode).toBe(200);
      const body = envelope<{ metrics: Metrics; previous: null }>(response.body);
      expect(body.success).toBe(true);
      expect(body.data?.metrics).toEqual({
        visitors: 2,
        pageviews: 3,
        visits: 2,
        bounces: 1,
        bounceRate: 0.5,
        // v_1 stayed ten minutes and v_2 one, so the average stay is five and a
        // half minutes: 330 seconds, not the 300 a glance at the data suggests.
        avgDurationMs: 330_000,
      });
      expect(body.data?.previous).toBeNull();
      expect(body.meta).toMatchObject({ siteId: SITE_ID, timezone: 'UTC', from: TODAY_START });
    });

    it('reads a rolled up day and today together', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/aggregate?from=${YESTERDAY_START}&to=${NOW}`,
      );
      const metrics = envelope<{ metrics: Metrics }>(response.body).data?.metrics;
      // Three visitors over two days, which is the sum of each day's uniques.
      expect(metrics?.visitors).toBe(3);
      expect(metrics?.pageviews).toBe(4);
    });

    it('carries a comparison when asked for one', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/aggregate?from=${TODAY_START}&to=${TOMORROW}&compare=previous_period`,
      );
      const body = envelope<{ previous: Metrics; previousRange: { from: number } }>(response.body);
      expect(body.data?.previousRange.from).toBe(YESTERDAY_START);
      expect(body.data?.previous.visitors).toBe(1);
    });

    // The names in the artifact's route list, not the field names the store uses.
    it('narrows the answer to the metrics that were asked for', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/aggregate?${today}&metrics=visitors,bounce_rate,duration`,
      );
      expect(envelope<{ metrics: Partial<Metrics> }>(response.body).data?.metrics).toEqual({
        visitors: 2,
        bounceRate: 0.5,
        avgDurationMs: 330_000,
      });
    });

    it('refuses a metric it does not know rather than quietly dropping it', async () => {
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/aggregate?${today}&metrics=visitors,revenue`),
        400,
        'INVALID_QUERY',
      );
    });

    // Zero for everything reads as "nobody came" rather than "you asked for
    // nothing".
    it('refuses a range that ends before it starts', async () => {
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/aggregate?from=${NOW}&to=${TODAY_START}`),
        400,
        'INVALID_RANGE',
      );
    });

    it('accepts an ISO date as well as epoch milliseconds', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/aggregate?from=2026-09-18T00:00:00Z&to=2026-09-19T00:00:00Z`,
      );
      expect(envelope<{ metrics: Metrics }>(response.body).data?.metrics.visitors).toBe(2);
    });

    it('refuses a range it cannot read at all', async () => {
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/aggregate?from=yesterday&to=today`),
        400,
        'INVALID_QUERY',
      );
      expectFailure(await get(`/api/sites/${SITE_ID}/stats/aggregate`), 400, 'INVALID_QUERY');
    });
  });

  describe('timeseries', () => {
    it('gives one point per day by default', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/timeseries?from=${YESTERDAY_START}&to=${TOMORROW}`,
      );
      const body = envelope<{
        interval: string;
        points: { start: number; metrics: Metrics }[];
      }>(response.body);
      expect(body.data?.interval).toBe('day');
      expect(body.data?.points).toHaveLength(2);
      expect(body.data?.points[0]?.start).toBe(YESTERDAY_START);
      expect(body.data?.points[0]?.metrics.visitors).toBe(1);
      expect(body.data?.points[1]?.metrics.visitors).toBe(2);
      expect(body.data?.points[1]?.metrics.pageviews).toBe(3);
    });

    it('gives one point per hour when asked, with the traffic in the hour it happened', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/timeseries?${today}&interval=hour`,
      );
      const points = envelope<{ points: { start: number; metrics: Metrics }[] }>(response.body).data
        ?.points;
      expect(points).toHaveLength(12);
      const eleven = points?.find((point) => point.start === NOW - HOUR);
      expect(eleven?.metrics.pageviews).toBe(3);
      expect(eleven?.metrics.visitors).toBe(2);
      const midnight = points?.find((point) => point.start === TODAY_START);
      expect(midnight?.metrics.pageviews).toBe(0);
    });

    // An hourly series reads raw rows for the whole range, so it is capped.
    it('refuses an hourly series longer than a week', async () => {
      expectFailure(
        await get(
          `/api/sites/${SITE_ID}/stats/timeseries?from=${TOMORROW - 8 * 24 * HOUR}&to=${TOMORROW}&interval=hour`,
        ),
        400,
        'RANGE_TOO_LONG',
      );
    });

    // The live view. A point a minute, and a cap far harder than the hourly one
    // because a minute has no rollup either and nobody reads four thousand
    // points.
    it('gives one point per minute when asked', async () => {
      const from = NOW - 30 * 60_000;
      const response = await get(
        `/api/sites/${SITE_ID}/stats/timeseries?from=${from}&to=${NOW}&interval=minute`,
      );
      const body = envelope<{ interval: string; points: { start: number; metrics: Metrics }[] }>(
        response.body,
      ).data;
      expect(body?.interval).toBe('minute');
      expect(body?.points).toHaveLength(30);
      expect(body?.points[0]?.start).toBe(from);
      const atThirty = body?.points.find((point) => point.start === NOW - 30 * 60_000);
      expect(atThirty?.metrics.pageviews).toBe(1);
      const total = body?.points.reduce((sum, point) => sum + point.metrics.pageviews, 0);
      expect(total).toBe(1);
    });

    it('refuses a minute series longer than three hours', async () => {
      expectFailure(
        await get(
          `/api/sites/${SITE_ID}/stats/timeseries?from=${NOW - 4 * HOUR}&to=${NOW}&interval=minute`,
        ),
        400,
        'RANGE_TOO_LONG',
      );
    });

    it('gives one point for a week and one for a month', async () => {
      const week = await get(
        `/api/sites/${SITE_ID}/stats/timeseries?from=${YESTERDAY_START}&to=${TOMORROW}&interval=week`,
      );
      expect(envelope<{ points: unknown[] }>(week.body).data?.points).toHaveLength(1);
      const month = await get(
        `/api/sites/${SITE_ID}/stats/timeseries?from=${YESTERDAY_START}&to=${TOMORROW}&interval=month`,
      );
      expect(envelope<{ points: unknown[] }>(month.body).data?.points).toHaveLength(1);
    });
  });

  describe('breakdown', () => {
    it('breaks the range down by a dimension, biggest first', async () => {
      const response = await get(`/api/sites/${SITE_ID}/stats/breakdown?${today}&dim=page`);
      const rows = envelope<{ dim: string; rows: { key: string; metrics: Metrics }[] }>(
        response.body,
      ).data;
      expect(rows?.dim).toBe('page');
      expect(rows?.rows.map((row) => row.key)).toEqual(['/pricing', '/']);
      expect(rows?.rows[0]?.metrics.visitors).toBe(2);
    });

    it('breaks down by the dimensions an event carries', async () => {
      for (const [dim, key] of [
        ['country', 'BD'],
        ['city', 'Dhaka'],
        ['browser', 'Chrome'],
        ['os', 'Windows'],
        ['device', 'desktop'],
        ['lang', 'en'],
      ] as const) {
        const response = await get(`/api/sites/${SITE_ID}/stats/breakdown?${today}&dim=${dim}`);
        const rows = envelope<{ rows: { key: string }[] }>(response.body).data?.rows;
        expect(rows?.[0]?.key, dim).toBe(key);
      }
    });

    it('honours a limit', async () => {
      const response = await get(`/api/sites/${SITE_ID}/stats/breakdown?${today}&dim=page&limit=1`);
      expect(envelope<{ rows: unknown[] }>(response.body).data?.rows).toHaveLength(1);
    });

    it('refuses a breakdown with no dimension and one it does not know', async () => {
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/breakdown?${today}`),
        400,
        'MISSING_DIMENSION',
      );
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/breakdown?${today}&dim=nonsense`),
        400,
        'INVALID_QUERY',
      );
    });
  });

  describe('filters', () => {
    it('takes the compact form a person would type', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/aggregate?${today}&filters=page==/pricing`,
      );
      expect(envelope<{ metrics: Metrics }>(response.body).data?.metrics.pageviews).toBe(2);
    });

    it('takes the JSON form a dashboard would build', async () => {
      const filters = encodeURIComponent('[{"dim":"page","op":"is_not","value":"/pricing"}]');
      const response = await get(
        `/api/sites/${SITE_ID}/stats/aggregate?${today}&filters=${filters}`,
      );
      expect(envelope<{ metrics: Metrics }>(response.body).data?.metrics.pageviews).toBe(1);
    });

    it('takes contains, and several clauses at once', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/aggregate?${today}&filters=${encodeURIComponent('city~Dha;browser==Chrome')}`,
      );
      expect(envelope<{ metrics: Metrics }>(response.body).data?.metrics.visitors).toBe(2);
    });

    it('refuses a clause with no operator and a dimension it does not know', async () => {
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/aggregate?${today}&filters=page`),
        400,
        'INVALID_QUERY',
      );
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/aggregate?${today}&filters=nonsense==x`),
        400,
        'INVALID_QUERY',
      );
    });

    // Refused rather than answered with an empty report, because an empty report is
    // a silent wrong number. AN-SEG01 owns the segment that answers it.
    it('refuses a filter raw rows cannot answer', async () => {
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/aggregate?${today}&filters=entry==/pricing`),
        400,
        'UNSUPPORTED_FILTER',
      );
    });
  });

  // Time on page and scroll depth, from the leave beacons and from nothing
  // else, which is why this is a route of its own rather than two more metrics
  // on a breakdown.
  describe('engagement', () => {
    it('answers the time on page and the scroll depth of each page', async () => {
      const response = await get(`/api/sites/${SITE_ID}/stats/engagement?${today}&dim=page`);
      const body = envelope<{
        dim: string;
        rawOnly: boolean;
        rows: { key: string; avgTimeOnPageMs: number | null; avgScrollDepth: number | null; leaves: number }[];
      }>(response.body);
      expect(response.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data?.dim).toBe('page');
      // Said on the wire, because it is what decides how far back this report
      // can see: a rollup holds no leave beacon.
      expect(body.data?.rawOnly).toBe(true);
      expect(body.data?.rows).toEqual([
        { key: '/pricing', avgTimeOnPageMs: 62_000, avgScrollDepth: 75, leaves: 1 },
      ]);
    });

    it('carries the site and the range in the meta, the way the other reports do', async () => {
      const response = await get(`/api/sites/${SITE_ID}/stats/engagement?${today}&dim=page`);
      expect(envelope(response.body).meta).toMatchObject({ siteId: SITE_ID, from: TODAY_START });
    });

    // rawOnly says this report cannot see past the raw events, and a true with
    // no number beside it leaves a dashboard to ask a second route how far back
    // that is before it can say so on screen.
    it('says how far back raw events go, beside the flag that says it matters', async () => {
      const response = await get(`/api/sites/${SITE_ID}/stats/engagement?${today}&dim=page`);
      const body = envelope<{ rawOnly: boolean }>(response.body);
      expect(body.data?.rawOnly).toBe(true);
      expect(body.meta?.retentionDays).toBeTypeOf('number');
      expect(body.meta?.retentionDays).toBeGreaterThan(0);
    });

    it('answers no rows for a range whose pages nobody has left yet', async () => {
      const response = await get(
        `/api/sites/${SITE_ID}/stats/engagement?from=${YESTERDAY_START}&to=${TODAY_START}&dim=page`,
      );
      expect(envelope<{ rows: unknown[] }>(response.body).data?.rows).toEqual([]);
    });

    it('refuses a dimension a leave beacon does not carry, and a read with none', async () => {
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/engagement?${today}&dim=entry`),
        400,
        'UNSUPPORTED_DIMENSION',
      );
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/engagement?${today}`),
        400,
        'MISSING_DIMENSION',
      );
    });

    it('refuses nobody with the envelope and lets a viewer read it', async () => {
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/engagement?${today}&dim=page`, {}),
        401,
        'UNAUTHENTICATED',
      );
      const viewer = await harness.account({
        email: 'engagement-viewer@test.example',
        role: 'viewer',
      });
      const response = await get(`/api/sites/${SITE_ID}/stats/engagement?${today}&dim=page`, {
        cookie: viewer.cookie,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('export.csv', () => {
    it('answers a CSV file with the same numbers the JSON has', async () => {
      const response = await get(`/api/sites/${SITE_ID}/export.csv?${today}&dim=page`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="${SITE_ID}-page-2026-09-18.csv"`,
      );
      const lines = response.body.trimEnd().split('\r\n');
      expect(lines[0]).toBe('key,visitors,pageviews,visits,bounces,bounce_rate,avg_duration_ms');
      // A visit spans pages rather than being one, so the three session numbers
      // read 0 on a page breakdown and the two rates read blank. Blank and not
      // zero, so a spreadsheet averaging the column does not average invented
      // zeroes. AN-SES01 is where page, screen, lang and event became the four.
      expect(lines[1]).toBe('/pricing,2,2,0,0,,');
      expect(lines[2]).toBe('/,1,1,0,0,,');
    });

    // The one body that is not the envelope is still the envelope when it fails.
    it('answers a refusal with the envelope, not with a broken file', async () => {
      const response = await get(`/api/sites/${SITE_ID}/export.csv?${today}`);
      expectFailure(response, 400, 'MISSING_DIMENSION');
      expect(response.headers['content-type']).toContain('application/json');
    });
  });

  describe('who may read a report', () => {
    it('refuses nobody with the envelope', async () => {
      expectFailure(
        await harness.app.inject({
          method: 'GET',
          url: `/api/sites/${SITE_ID}/stats/aggregate?${today}`,
        }),
        401,
        'UNAUTHENTICATED',
      );
    });

    it('lets a viewer read the numbers', async () => {
      const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
      const response = await get(`/api/sites/${SITE_ID}/stats/aggregate?${today}`, {
        cookie: viewer.cookie,
      });
      expect(response.statusCode).toBe(200);
    });

    // Presenting a key at another site is not a smaller permission, it is the wrong
    // key.
    it('refuses a key minted for another site', async () => {
      const key = await harness.key(['read:stats'], 's_somewhere_else');
      expectFailure(
        await get(`/api/sites/${SITE_ID}/stats/aggregate?${today}`, { authorization: key }),
        403,
        'SITE_FORBIDDEN',
      );
    });
  });
});
