import type { GeoReader } from '@chokh/geo';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { defaultSiteSettings, startOfDay, type Site } from '../store/AnalyticsStore.js';
import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';

// The seam between the collector and a report.
//
// A conformance suite proves an adapter against a fixture, and a route test
// proves the collector against a payload, but neither can see the two packages
// disagreeing about what a field is called. That is exactly how the UTM
// dimensions shipped reading `utm.utm_source` while the tracker sends
// `utm.source`: both halves were self consistent and every campaign report was
// empty. This test posts the payload from packages/tracker/README.md through
// the real route and reads it back out of a breakdown, so a rename on the wire
// breaks a test instead of a dashboard.

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const geo: GeoReader = { lookup: () => ({ country: 'BD', city: 'Dhaka' }) };

const site: Site = {
  id: 'ps_web',
  name: 'Fixture',
  domains: ['example.test'],
  settings: defaultSiteSettings({ visitorIdMode: 'persistent' }),
};

// The README's payload, with the site key and hostname this fixture answers to
// so the origin check passes. Everything a report reads is verbatim.
function readmeBatch(): unknown {
  return {
    siteId: 'ps_web',
    sentAt: Date.now(),
    hostname: 'example.test',
    lang: 'en-US',
    screen: '1920x1080',
    viewport: '1280x720',
    visitorId: 'kq2b7w3m9pa',
    userId: 'user_42',
    events: [
      {
        type: 'pageview',
        ts: Date.now(),
        path: '/courses/cp-beginners',
        title: 'Competitive programming for beginners',
        referrer: 'https://www.google.com/',
        utm: { source: 'facebook', campaign: 'imupc' },
      },
    ],
  };
}

let store: MemoryStore;
let app: FastifyInstance;

beforeEach(async () => {
  store = createMemoryStore([site]);
  app = await buildApp({ store, geo });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function post(body: unknown): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/collect',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      origin: 'https://example.test',
      'user-agent': CHROME,
    },
    payload: JSON.stringify(body),
  });
  return response.statusCode;
}

// Today only, so the read never crosses into a day that would want a rollup.
function today(): { siteId: string; from: number; to: number } {
  const at = Date.now();
  return { siteId: site.id, from: startOfDay(at, site.settings.timezone), to: at + 1000 };
}

describe('a collected batch reaches a report', () => {
  it('breaks the campaign down by the names a person typed into the link', async () => {
    expect(await post(readmeBatch())).toBe(202);

    const source = await store.breakdown({ ...today(), dim: 'utm_source' });
    expect(source.rows).toEqual([
      { key: 'facebook', metrics: expect.objectContaining({ visitors: 1, pageviews: 1 }) },
    ]);

    const campaign = await store.breakdown({ ...today(), dim: 'utm_campaign' });
    expect(campaign.rows).toEqual([
      { key: 'imupc', metrics: expect.objectContaining({ visitors: 1, pageviews: 1 }) },
    ]);

    // The parameters the link did not carry stay absent rather than empty.
    const medium = await store.breakdown({ ...today(), dim: 'utm_medium' });
    expect(medium.rows).toEqual([]);
  });

  it('breaks the same batch down by the page, the referrer and the device', async () => {
    expect(await post(readmeBatch())).toBe(202);

    const page = await store.breakdown({ ...today(), dim: 'page' });
    expect(page.rows[0]?.key).toBe('/courses/cp-beginners');

    const referrer = await store.breakdown({ ...today(), dim: 'referrer' });
    expect(referrer.rows[0]?.key).toBe('https://www.google.com/');

    const country = await store.breakdown({ ...today(), dim: 'country' });
    expect(country.rows[0]?.key).toBe('BD');

    const browser = await store.breakdown({ ...today(), dim: 'browser' });
    expect(browser.rows[0]?.key).toBe('Chrome');

    const lang = await store.breakdown({ ...today(), dim: 'lang' });
    expect(lang.rows[0]?.key).toBe('en-US');
  });

  it('counts the visitor and the pageview the collector stored', async () => {
    expect(await post(readmeBatch())).toBe(202);

    const totals = await store.aggregate(today());
    expect(totals.metrics.visitors).toBe(1);
    expect(totals.metrics.pageviews).toBe(1);

    const profile = await store.user(site.id, 'user_42');
    expect(profile?.visitorIds).toEqual(['kq2b7w3m9pa']);
    expect(profile?.pageviews).toBe(1);
  });
});
