import type { GeoReader } from '@chokh/geo';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import type { ClientIpOptions } from '../lib/client-ip.js';
import { signForwardedAddress } from '../lib/forwarded-address.js';
import { signUserId } from '../lib/identity-signature.js';
import type { CollectBatch } from '../schemas/collect.schema.js';
import { defaultSiteSettings, type Site } from '../store/AnalyticsStore.js';
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
    settings: defaultSiteSettings({
      ipMode: 'full',
      visitorIdMode: 'cookieless',
      ...overrides,
    }),
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

async function start(seed: Site = site(), ip?: ClientIpOptions): Promise<void> {
  store = createMemoryStore([seed]);
  app = await buildApp(ip === undefined ? { store, geo } : { store, geo, ip });
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
    // The dedupe window is a pageview rule. A vital repeated inside it is two
    // vitals, because two measurements of one page are two measurements.
    await post(batch());
    await post(batch({ events: [{ type: 'pageview', ts: Date.now(), path: '/other' }] }));
    await post(batch({ events: [{ type: 'vital', ts: Date.now(), path: '/', name: 'LCP' }] }));
    await post(batch({ events: [{ type: 'vital', ts: Date.now(), path: '/', name: 'CLS' }] }));

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

// A placeholder, never a real key: no secret belongs in this repository.
const SECRET = 'test-secret-not-a-real-key';

function identifies(userId: string, sig?: string): CollectBatch {
  const body = batch({
    userId,
    events: [{ type: 'identify', ts: Date.now(), path: '/', userId, traits: { plan: 'pro' } }],
  });
  return sig === undefined ? body : { ...body, sig };
}

describe('an identify the site will not confirm', () => {
  it('is dropped, and nothing in the batch carries the name', async () => {
    await app.close();
    await start(site({ allowUnsignedIdentify: false, identifySecret: SECRET }));

    const response = await post({
      ...identifies('user_42'),
      events: [
        { type: 'identify', ts: Date.now(), path: '/', userId: 'user_42', traits: { plan: 'pro' } },
        { type: 'pageview', ts: Date.now(), path: '/account' },
      ],
    });

    // The batch is still collected, and collected anonymously: the pageview is
    // real traffic whatever the page claimed about who sent it.
    expect(response.statusCode).toBe(202);
    const stored = store.stored();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.type).toBe('pageview');
    expect(stored[0]?.userId).toBeUndefined();
    expect(stored[0]?.traits).toBeUndefined();
  });

  it('never reaches the visitor row or a per-user lookup', async () => {
    await app.close();
    await start(site({ allowUnsignedIdentify: false, identifySecret: SECRET }));

    await post(identifies('user_42'));

    expect(await store.user('ps_web', 'user_42')).toBeNull();
    const visitorId = store.stored()[0]?.visitorId;
    expect(visitorId).toBeUndefined();
  });

  it('is taken when the site signed it', async () => {
    await app.close();
    await start(site({ allowUnsignedIdentify: false, identifySecret: SECRET }));

    await post(identifies('user_42', signUserId(SECRET, 'ps_web', 'user_42')));

    expect(store.stored()[0]).toMatchObject({ userId: 'user_42', traits: { plan: 'pro' } });
    expect(await store.user('ps_web', 'user_42')).not.toBeNull();
  });

  it('is refused when the signature is for somebody else', async () => {
    await app.close();
    await start(site({ allowUnsignedIdentify: false, identifySecret: SECRET }));

    await post(identifies('user_42', signUserId(SECRET, 'ps_web', 'user_99')));

    expect(store.stored()).toHaveLength(0);
    expect(await store.user('ps_web', 'user_42')).toBeNull();
  });

  it('is refused on a permissive site too when a wrong signature is sent', async () => {
    await app.close();
    await start(site({ identifySecret: SECRET }));

    await post(identifies('user_42', 'forged'));

    expect(store.stored()).toHaveLength(0);
  });
});

describe('sessions, written as the batch is ingested', () => {
  it('opens one stay and stamps it on every event of it', async () => {
    // Backdated, because the collector bounds an event to the moment the
    // batch arrived and a clock from the future would all land on one instant.
    const at = Date.now() - 60_000;
    await post(
      batch({
        visitorId: 'v_persistent',
        events: [
          { type: 'pageview', ts: at, path: '/home' },
          { type: 'pageview', ts: at + 1000, path: '/pricing' },
          { type: 'leave', ts: at + 2000, path: '/pricing', duration: 2000, scrollDepth: 50 },
        ],
      }),
    );

    const stored = store.stored();
    const ids = new Set(stored.map((event) => event.sessionId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();

    const visitorId = stored[0]?.visitorId ?? '';
    const sessions = store.sessionsOf('ps_web', visitorId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      entryPath: '/home',
      exitPath: '/pricing',
      pageviews: 2,
      duration: 2000,
      endedAt: at + 2000,
      isNew: true,
      // The referrer of the first event of the batch decided it.
      channel: 'direct',
    });
  });

  it('shows the visitor as online through realtime, off the presence set', async () => {
    await post(batch({ visitorId: 'v_persistent' }));

    const snapshot = await store.realtime('ps_web');
    expect(snapshot.online).toBe(1);
    expect(snapshot.visitors[0]?.path).toBe('/courses/cp-beginners');
    expect(snapshot.byCountry).toEqual([]);
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

describe('a forwarded address the first-party proxy signed', () => {
  // A placeholder, never a real key.
  const SECRET = 'test-proxy-secret-not-a-real-key-0000';
  // What the peer chain says, which is the proxy's own address: what every
  // visitor of the site would be stored as without the header pair.
  const PEER = '198.51.100.7';
  const VISITOR = '103.87.12.45';

  function pair(ip: string, ts: number, sig?: string): Record<string, string> {
    return {
      'x-forwarded-for': PEER,
      'x-chokh-forwarded-for': ip,
      'x-chokh-forwarded-sig': `${ts}.${sig ?? signForwardedAddress(SECRET, ip, ts)}`,
    };
  }

  beforeEach(async () => {
    await app.close();
    await start(site(), {
      trustProxy: ['127.0.0.1/32', '::1/128'],
      realIpHeader: 'x-chokh-forwarded-for',
      proxySecret: SECRET,
    });
  });

  it('stores the visitor the proxy named, and looks them up there', async () => {
    await post(batch(), pair(VISITOR, Date.now()));

    const stored = store.stored()[0];
    expect(stored?.ip).toBe(VISITOR);
    expect(stored?.geo).toMatchObject({ country: 'BD', city: 'Dhaka' });
  });

  // A beacon cannot read a refusal, so a signature that does not check out is
  // never one. The batch lands on the peer chain instead.
  it('ignores a forged signature and stores the peer', async () => {
    const response = await post(batch(), pair(VISITOR, Date.now(), 'forged'));

    expect(response.statusCode).toBe(202);
    expect(store.stored()[0]?.ip).toBe(PEER);
  });

  it('ignores a signature made with another secret and stores the peer', async () => {
    const ts = Date.now();
    const headers = {
      'x-forwarded-for': PEER,
      'x-chokh-forwarded-for': VISITOR,
      'x-chokh-forwarded-sig': `${ts}.${signForwardedAddress('a-different-placeholder', VISITOR, ts)}`,
    };

    await post(batch(), headers);

    expect(store.stored()[0]?.ip).toBe(PEER);
  });

  // One read out of a proxy log is worth nothing two minutes later.
  it('ignores a stale ts and stores the peer', async () => {
    await post(batch(), pair(VISITOR, Date.now() - 121_000));

    expect(store.stored()[0]?.ip).toBe(PEER);
  });

  it('stores the peer for a request that carries no pair at all', async () => {
    await post(batch(), { 'x-forwarded-for': PEER });

    expect(store.stored()[0]?.ip).toBe(PEER);
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

// The site's own traffic, kept out by the three lists on the site row. Over
// HTTP, because the point is what a batch does and does not leave behind.
describe("the site's own traffic", () => {
  it('drops a batch from an excluded address, answering as if it were collected', async () => {
    await start(site({ excludeIps: ['103.87.12.0/24'] }));
    const response = await post(batch(), { 'x-forwarded-for': '103.87.12.45' });
    expect(response.statusCode).toBe(202);
    expect(store.stored()).toHaveLength(0);

    await post(batch(), { 'x-forwarded-for': '103.88.1.1' });
    expect(store.stored()).toHaveLength(1);
  });

  it('drops the events on an excluded path and keeps the rest of the batch', async () => {
    await start(site({ excludePaths: ['/admin/*'] }));
    const now = Date.now();
    await post(
      batch({
        events: [
          { type: 'pageview', ts: now, path: '/admin/users' },
          { type: 'pageview', ts: now + 1, path: '/pricing' },
          { type: 'event', ts: now + 2, path: '/admin/users', name: 'saved' },
        ],
      }),
    );
    expect(store.stored().map((event) => event.path)).toEqual(['/pricing']);
  });

  it('takes an excluded parameter off a path and a referrer before either is stored', async () => {
    await start(site({ excludeQueryParams: ['sid'] }));
    const now = Date.now();
    await post(
      batch({
        events: [
          {
            type: 'pageview',
            ts: now,
            path: '/app?sid=abc&tab=2',
            referrer: 'https://ref.example/?sid=1&q=x',
          },
        ],
      }),
    );
    expect(store.stored()[0]).toMatchObject({ path: '/app?tab=2', referrer: 'https://ref.example/?q=x' });
  });
});
