import type { GeoReader } from '@chokh/geo';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import type { CollectBatch } from '../schemas/collect.schema.js';
import type { Site } from '../store/AnalyticsStore.js';
import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const geo: GeoReader = {
  lookup: (ip) =>
    ip.startsWith('103.87.')
      ? { country: 'BD', region: 'Dhaka Division', city: 'Dhaka', tz: 'Asia/Dhaka' }
      : {},
};

function site(overrides: Partial<Site['settings']> = {}): Site {
  return {
    id: 'ps_web',
    name: 'Fixture',
    domains: ['example.test', 'www.example.test'],
    settings: {
      ipMode: 'full',
      visitorIdMode: 'cookieless',
      botFilter: true,
      ...overrides,
    },
  };
}

function batch(overrides: Partial<CollectBatch> = {}): CollectBatch {
  return {
    siteId: 'ps_web',
    sentAt: Date.now(),
    hostname: 'example.test',
    lang: 'en-US',
    screen: '1920x1080',
    viewport: '1280x720',
    events: [
      {
        type: 'pageview',
        ts: Date.now(),
        path: '/courses/cp-beginners',
        title: 'Competitive programming',
        referrer: 'https://www.google.com/',
        utm: { source: 'facebook', campaign: 'imupc' },
      },
    ],
    ...overrides,
  };
}

let store: MemoryStore;
let app: FastifyInstance;

async function post(body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/collect',
    headers: {
      // The tracker posts JSON under a text/plain content type.
      'content-type': 'text/plain;charset=UTF-8',
      origin: 'https://example.test',
      'user-agent': CHROME,
      ...headers,
    },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function start(seed: Site = site()): Promise<void> {
  store = createMemoryStore([seed]);
  app = await buildApp({ store, geo });
  await app.ready();
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/collect', () => {
  it('answers 202 with no body and stores the batch through the adapter', async () => {
    const response = await post(batch());

    expect(response.statusCode).toBe(202);
    expect(response.body).toBe('');

    const stored = store.stored();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      siteId: 'ps_web',
      type: 'pageview',
      path: '/courses/cp-beginners',
      title: 'Competitive programming',
      referrer: 'https://www.google.com/',
      utm: { source: 'facebook', campaign: 'imupc' },
      hostname: 'example.test',
      lang: 'en-US',
      screen: '1920x1080',
      bot: false,
    });
    expect(stored[0]?.visitorId).toBeTruthy();
  });

  it('enriches every event with the user agent and the location', async () => {
    await post(batch(), { 'x-forwarded-for': '103.87.12.45' });

    const stored = store.stored()[0];
    expect(stored?.ua).toMatchObject({ browser: 'Chrome', os: 'Windows', device: 'desktop' });
    expect(stored?.geo).toMatchObject({ country: 'BD', region: 'Dhaka Division', city: 'Dhaka' });
  });

  it('prefers Client Hints over the user agent string', async () => {
    await post(batch(), {
      'sec-ch-ua': '"Chromium";v="131", "Brave";v="131", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
    });

    expect(store.stored()[0]?.ua).toMatchObject({
      browser: 'Brave',
      os: 'Android',
      device: 'mobile',
    });
  });

  it('bounds an event timestamp from the future to the moment it arrived', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    await post(batch({ events: [{ type: 'pageview', ts: future, path: '/' }] }));

    const stored = store.stored()[0];
    expect(stored?.ts).toBeLessThanOrEqual(stored?.receivedAt ?? 0);
  });

  it('tags a crawler rather than dropping it, so the bot share can be shown', async () => {
    await post(batch(), { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });

    expect(store.stored()).toHaveLength(1);
    expect(store.stored()[0]?.bot).toBe(true);
  });

  it('does not tag a bot when the site turned the filter off', async () => {
    await app.close();
    await start(site({ botFilter: false }));

    await post(batch(), { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });

    expect(store.stored()[0]?.bot).toBe(false);
  });

  it('counts a pageview repeated within two seconds once', async () => {
    await post(batch());
    await post(batch());

    expect(store.stored()).toHaveLength(1);
  });

  it('keeps a repeat of a different path, and a repeat that is not a pageview', async () => {
    await post(batch());
    await post(batch({ events: [{ type: 'pageview', ts: Date.now(), path: '/other' }] }));
    await post(batch({ events: [{ type: 'heartbeat', ts: Date.now(), path: '/' }] }));
    await post(batch({ events: [{ type: 'heartbeat', ts: Date.now(), path: '/' }] }));

    expect(store.stored()).toHaveLength(4);
  });

  it('keeps the visitor id the tracker sent when the site runs persistent mode', async () => {
    await app.close();
    await start(site({ visitorIdMode: 'persistent' }));

    await post(batch({ visitorId: 'kq2b7w3m9pa' }));

    expect(store.stored()[0]?.visitorId).toBe('kq2b7w3m9pa');
  });

  it('derives its own visitor id when the site is cookieless, whatever the tracker sent', async () => {
    await post(batch({ visitorId: 'kq2b7w3m9pa' }));

    expect(store.stored()[0]?.visitorId).not.toBe('kq2b7w3m9pa');
  });

  it('carries the identified user onto the events of the batch', async () => {
    await post(
      batch({
        userId: 'user_42',
        events: [
          {
            type: 'identify',
            ts: Date.now(),
            path: '/',
            userId: 'user_42',
            traits: { plan: 'pro' },
          },
        ],
      }),
    );

    expect(store.stored()[0]).toMatchObject({
      type: 'identify',
      userId: 'user_42',
      traits: { plan: 'pro' },
    });
  });
});

describe('the site IP mode, applied before anything is stored', () => {
  it('stores the address as it arrived in full mode', async () => {
    await post(batch(), { 'x-forwarded-for': '103.87.12.45' });

    expect(store.stored()[0]?.ip).toBe('103.87.12.45');
  });

  it('zeroes the last octet in anonymized mode', async () => {
    await app.close();
    await start(site({ ipMode: 'anonymized' }));

    await post(batch(), { 'x-forwarded-for': '103.87.12.45' });

    expect(store.stored()[0]?.ip).toBe('103.87.12.0');
  });

  it('stores nothing at all in none mode', async () => {
    await app.close();
    await start(site({ ipMode: 'none' }));

    await post(batch(), { 'x-forwarded-for': '103.87.12.45' });

    const stored = store.stored()[0];
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('ip');
  });

  it('still knows the visitor and the location in none mode, from an address it never stores', async () => {
    await app.close();
    await start(site({ ipMode: 'none' }));

    await post(batch(), { 'x-forwarded-for': '103.87.12.45' });

    const stored = store.stored()[0];
    expect(stored?.visitorId).toBeTruthy();
    expect(stored?.geo).toMatchObject({ country: 'BD' });
  });
});

describe('the site and its origin', () => {
  it('refuses a key no site answers to', async () => {
    const response = await post(batch({ siteId: 'unknown' }));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'UNKNOWN_SITE' } });
    expect(store.stored()).toHaveLength(0);
  });

  it('refuses an origin that is not a domain of the site', async () => {
    const response = await post(batch(), { origin: 'https://elsewhere.test' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
  });

  it('accepts any domain the site lists', async () => {
    const response = await post(batch(), { origin: 'https://www.example.test' });
    expect(response.statusCode).toBe(202);
  });

  it('falls back to the Referer when a browser sent no Origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/collect',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        referer: 'https://example.test/courses',
        'user-agent': CHROME,
      },
      payload: JSON.stringify(batch()),
    });

    expect(response.statusCode).toBe(202);
  });

  it('refuses a post that says where it came from in neither header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/collect',
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': CHROME },
      payload: JSON.stringify(batch()),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('a body the collector cannot use', () => {
  it('refuses a batch that does not validate', async () => {
    const response = await post({ siteId: 'ps_web', events: [] });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'INVALID_BATCH' } });
  });

  it('refuses a body that is not JSON', async () => {
    const response = await post('this is not json');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'INVALID_JSON' } });
  });

  it('reads the body as JSON whatever the content type claims', async () => {
    const response = await post(batch(), { 'content-type': 'application/octet-stream' });
    expect(response.statusCode).toBe(202);
  });
});
