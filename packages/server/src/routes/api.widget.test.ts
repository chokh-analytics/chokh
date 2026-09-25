import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  NOW,
  SITE_ID,
  testSite,
  type Harness,
} from './api.test-utils.js';
import type { StoredEvent } from '../store/AnalyticsStore.js';

// The stat badge under a share (AN-RPT01), over HTTP.

const HOUR = 60 * 60 * 1000;

function pageview(visitorId: string, ts: number): StoredEvent {
  return {
    siteId: SITE_ID,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId,
    path: '/',
    hostname: 'test.example',
    bot: false,
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country: 'BD', city: 'Dhaka' },
    lang: 'en',
  };
}

describe('the share badge', () => {
  let harness: Harness;
  let token = '';

  beforeAll(async () => {
    harness = await createHarness({ sites: [testSite()] });
    // Three people today, one of them twice; one person eight days ago.
    await harness.store.ingest([
      pageview('v_1', NOW - HOUR),
      pageview('v_1', NOW - HOUR + 60_000),
      pageview('v_2', NOW - 2 * HOUR),
      pageview('v_3', NOW - 3 * HOUR),
      pageview('v_old', NOW - 8 * 24 * HOUR),
    ]);
    // A past day is read from its rollup, as it is in production.
    await harness.store.rollupDay(SITE_ID, '2026-09-10');
    const made = await harness.app.inject({
      method: 'PUT',
      url: `/api/sites/${SITE_ID}/share`,
      headers: { cookie: harness.owner.cookie },
      payload: {},
    });
    token = envelope<{ share: { token: string } }>(made.body).data?.share.token ?? '';
  });

  afterAll(async () => {
    await harness.close();
  });

  function badge(query = '') {
    return harness.app.inject({ method: 'GET', url: `/api/share/${token}/widget.svg${query}` });
  }

  it('answers an SVG with the metric over the range, cached five minutes, for anybody with the link', async () => {
    const response = await badge();
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['x-robots-tag']).toBe('noindex');
    expect(response.body).toContain('<title>Visitors, 30 days: 4</title>');

    expect((await badge('?metric=pageviews&range=today')).body).toContain(
      '<title>Pageviews, today: 4</title>',
    );
    expect((await badge('?range=7d')).body).toContain('<title>Visitors, 7 days: 3</title>');
  });

  it('refuses a metric or a range it does not have, and a link nobody made', async () => {
    expectFailure(await badge('?metric=bounceRate'), 400, 'INVALID_QUERY');
    expectFailure(await badge('?range=12mo'), 400, 'INVALID_QUERY');
    expectFailure(
      await harness.app.inject({ method: 'GET', url: '/api/share/not-a-token/widget.svg' }),
      404,
      'UNKNOWN_SHARE',
    );
  });

  it('is locked when the share is', async () => {
    await harness.app.inject({
      method: 'PUT',
      url: `/api/sites/${SITE_ID}/share`,
      headers: { cookie: harness.owner.cookie },
      payload: { password: 'open-sesame' },
    });
    expectFailure(await badge(), 401, 'SHARE_LOCKED');
  });
});
