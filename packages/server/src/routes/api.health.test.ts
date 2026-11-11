import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  NOW,
  SITE_ID,
  testSite,
  type Harness,
} from './api.test-utils.js';
import type {
  CoverageResult,
  ErrorsResult,
  StoredEvent,
  VitalsResult,
} from '../store/AnalyticsStore.js';

// The health routes over HTTP (AN-VIT01): the envelope and its meta, the scope,
// the strict query strings and the caps, and what an error row lets through to
// a caller with read:stats and nothing more. The numbers are the conformance
// suite's; these cases prove what reaches the wire.

const DAY = 24 * 60 * 60 * 1000;
const OTHER_SITE = 's_other';

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    siteId: SITE_ID,
    ts: NOW - DAY,
    receivedAt: NOW - DAY,
    type: 'pageview',
    visitorId: 'v_1',
    path: '/',
    hostname: 'test.example',
    bot: false,
    ip: '203.0.113.7',
    ...overrides,
  };
}

describe('the health routes', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      sites: [
        testSite({
          settings: { ...testSite().settings, visitorIdMode: 'persistent', errorCapture: true },
        }),
        testSite({ id: OTHER_SITE, domains: ['other.example'] }),
      ],
    });
    const rows: StoredEvent[] = [];
    for (let at = 0; at < 20; at += 1) {
      rows.push(
        event({
          visitorId: `v_${at}`,
          userId: `u_${at}`,
          ts: NOW - DAY + at,
          type: 'vital',
          path: '/courses',
          name: 'LCP',
          value: 2000 + at * 100,
          ua: { browser: 'Chrome', device: 'mobile' },
        }),
      );
    }
    rows.push(
      event({
        type: 'error',
        visitorId: 'v_0',
        userId: 'u_0',
        name: 'TypeError: a is undefined',
        path: '/courses',
        frame: 'https://test.example/app.js:1:2',
        ua: { browser: 'Chrome', device: 'mobile' },
      }),
    );
    rows.push(event({ siteId: OTHER_SITE, type: 'error', name: 'Not yours' }));
    await harness.store.ingest(rows);
  });

  afterEach(async () => {
    await harness.close();
  });

  const range = `from=${NOW - 28 * DAY}&to=${NOW}`;

  function get(path: string, headers: Record<string, string> = { cookie: harness.owner.cookie }) {
    return harness.app.inject({ method: 'GET', url: `/api/sites/${SITE_ID}${path}`, headers });
  }

  describe('GET /stats/vitals', () => {
    it('answers the p75s and the slow pages in the envelope, raw and saying so', async () => {
      const response = await get(`/stats/vitals?${range}`);
      expect(response.statusCode).toBe(200);
      const body = envelope<VitalsResult>(response.body);
      expect(body.success).toBe(true);
      expect(body.data?.metrics[0]).toMatchObject({
        metric: 'LCP',
        p75: 3400,
        samples: 20,
        rating: 'needs-improvement',
      });
      expect(body.data?.pages.map((page) => page.page)).toEqual(['/courses']);
      expect(body.meta).toMatchObject({
        siteId: SITE_ID,
        rawOnly: true,
        retentionDays: expect.any(Number),
        sort: 'LCP',
        device: null,
      });
      const desktop = envelope<VitalsResult>((await get(`/stats/vitals?${range}&device=desktop`)).body);
      expect(desktop.data?.metrics[0]?.samples).toBe(0);
      const byInp = envelope<VitalsResult>((await get(`/stats/vitals?${range}&sort=INP`)).body);
      expect(byInp.data?.sort).toBe('INP');
    });

    it('refuses a filter, an unknown device or metric, a backwards range and more than 90 days', async () => {
      expectFailure(await get(`/stats/vitals?${range}&filters=page==/`), 400, 'INVALID_QUERY');
      expectFailure(await get(`/stats/vitals?${range}&device=watch`), 400, 'INVALID_QUERY');
      expectFailure(await get(`/stats/vitals?${range}&sort=FID`), 400, 'INVALID_QUERY');
      expectFailure(await get(`/stats/vitals?from=${NOW}&to=${NOW - DAY}`), 400, 'INVALID_RANGE');
      expectFailure(
        await get(`/stats/vitals?from=${NOW - 120 * DAY}&to=${NOW}`),
        400,
        'RANGE_TOO_LONG',
      );
    });
  });

  describe('GET /stats/errors', () => {
    it('answers the groups of this site only, with whether capture is on', async () => {
      const response = await get(`/stats/errors?${range}`);
      expect(response.statusCode).toBe(200);
      const body = envelope<ErrorsResult>(response.body);
      expect(body.data?.groups.map((group) => group.message)).toEqual(['TypeError: a is undefined']);
      expect(body.meta).toMatchObject({ errorCapture: true, errorStacks: false, limit: 50, rawOnly: true });
      expectFailure(await get(`/stats/errors?${range}&limit=500`), 400, 'INVALID_QUERY');
    });

    it('names nobody: a group carries counts, pages, browsers and its sample, and no person', async () => {
      const body = envelope<ErrorsResult>(
        (await get(`/stats/errors?${range}`, { authorization: await harness.key(['read:stats']) })).body,
      );
      const group = body.data?.groups[0];
      expect(Object.keys(group ?? {}).sort()).toEqual(
        ['browsers', 'count', 'firstSeen', 'lastSeen', 'message', 'pages', 'sample', 'visitors'],
      );
      expect(Object.keys(group?.sample ?? {}).sort()).toEqual(['at', 'browser', 'frame', 'page']);
      expect(response(body)).not.toMatch(/u_0|v_0|203\.0\.113/);
      // No identity read, so no audit row.
      expect(await harness.store.auditTrail(SITE_ID, 0, NOW + DAY)).toEqual([]);
    });
  });

  describe('GET /stats/coverage', () => {
    it('answers that it cannot be estimated for a site whose server sends nothing', async () => {
      const response = await get(`/stats/coverage?${range}`);
      expect(response.statusCode).toBe(200);
      const body = envelope<CoverageResult>(response.body);
      expect(body.data).toMatchObject({ state: 'no_server_events', people: 0, share: null, browserIdentified: 20 });
      expect(body.meta).toMatchObject({ rawOnly: true });
      expectFailure(await get(`/stats/coverage?${range}&limit=3`), 400, 'INVALID_QUERY');
    });
  });

  it('turns error capture and stacks on through the settings patch', async () => {
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/sites/${OTHER_SITE}`,
      headers: { cookie: harness.owner.cookie },
      payload: { settings: { errorCapture: true, errorStacks: true } },
    });
    expect(patched.statusCode).toBe(200);
    expect((await harness.store.site(OTHER_SITE))?.settings).toMatchObject({
      errorCapture: true,
      errorStacks: true,
    });
    expectFailure(
      await harness.app.inject({
        method: 'PATCH',
        url: `/api/sites/${OTHER_SITE}`,
        headers: { cookie: harness.owner.cookie },
        payload: { settings: { errorCapture: 'yes' } },
      }),
      400,
      'INVALID_BODY',
    );
  });

  it('answers 401 unsigned and 403 to a key without read:stats on every route', async () => {
    const key = await harness.key(['write:events']);
    for (const path of [`/stats/vitals?${range}`, `/stats/errors?${range}`, `/stats/coverage?${range}`]) {
      expectFailure(
        await harness.app.inject({ method: 'GET', url: `/api/sites/${SITE_ID}${path}` }),
        401,
        'UNAUTHENTICATED',
      );
      const refused = await get(path, { authorization: key });
      expect(refused.statusCode).toBe(403);
      expect(envelope(refused.body).success).toBe(false);
    }
  });
});

function response(body: unknown): string {
  return JSON.stringify(body);
}
