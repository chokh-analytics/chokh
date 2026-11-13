import type { AddressInfo } from 'node:net';

import { signForwardedAddress as signWithNodeCrypto } from '@chokh/sdk-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addressFrom, createCollectRoute, signForwardedAddress, visitorAddress } from './collect.js';

// The collect route, forwarding to the real Chokh collector: packages/server's
// buildApp on its memory store, booted in the X-Chokh-Forwarded-For mode with a
// proxy secret, exactly as a first-party install runs it. What is asserted is
// the row the collector stored: whose address it carries, which site, which
// browser. The collector answers 202 before its write lands, so a read waits
// for the row. The only thing between the route and the server is a recorder that
// notes the headers on the way past and then calls the real fetch.

process.env.LOG_LEVEL = 'silent';
process.env.SESSION_SECRET ??= 'chokh-next-test-session-secret-not-for-production';

const SITE = 's_next';
const SECRET = 'chokh-next-test-proxy-secret';
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// The shared forwarded-address vector, the same three inputs and the same
// string as packages/sdk-node/src/sign.test.ts and the server's
// forwarded-address.test.ts. This copy signs with Web Crypto, the other two
// with node:crypto; one formula.
const FORWARDED_VECTOR = {
  proxySecret: 'chokh-forwarded-test-vector-secret',
  ip: '103.87.12.45',
  ts: 1758268800000,
  signature: 'vxccd7YCjDD2KrAqUmGDrfSTHL5jlRlHITsOsLZqlho',
} as const;

interface Row {
  siteId: string;
  type: string;
  path?: string;
  ip?: string;
  ua?: { browser?: string };
}

let base: string;
let stored: () => Row[];
let seenBefore = 0;
let mark = (): void => undefined;
let close: () => Promise<void>;
let outgoing: Headers[] = [];

const recordingFetch: typeof fetch = async (input, init) => {
  outgoing.push(new Headers(init?.headers));
  return fetch(input, init);
};

beforeAll(async () => {
  const { buildApp } = await import('@chokh/server/app');
  const { createMemoryStore } = await import('@chokh/server/store/memory');
  const { defaultSiteSettings } = await import('@chokh/server/store');
  const store = createMemoryStore([]);
  await store.createSite({
    id: SITE,
    name: 'Next test site',
    domains: ['next.example'],
    teamId: 't_next',
    settings: defaultSiteSettings({ timezone: 'UTC', ipMode: 'full' }),
  });
  const app = await buildApp({
    store,
    ip: { trustProxy: [], realIpHeader: 'x-chokh-forwarded-for', proxySecret: SECRET },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  stored = () => (store.stored() as unknown as Row[]).slice(seenBefore).filter((row) => row.siteId === SITE);
  mark = () => {
    seenBefore = store.stored().length;
  };
  close = () => app.close();
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  mark();
  outgoing = [];
});

// Each case posts its own page: the collector folds a repeated view of one page
// by one visitor, and the cases share a browser.
function beacon(headers: Record<string, string>, path = '/pricing'): Request {
  return new Request('https://next.example/_pa/collect', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers },
    body: JSON.stringify({
      siteId: SITE,
      sentAt: 1,
      hostname: 'next.example',
      events: [{ type: 'pageview', ts: 1, path }],
    }),
  });
}

const browser = {
  origin: 'https://next.example',
  'user-agent': CHROME,
  'sec-ch-ua-mobile': '?0',
  'x-forwarded-for': '203.0.113.9, 10.0.0.1',
  cookie: 'session=secret',
  authorization: 'Bearer chk_secret',
};

describe('signForwardedAddress (Web Crypto)', () => {
  it('answers the shared vector, and what node:crypto in @chokh/sdk-node answers', async () => {
    const { proxySecret, ip, ts, signature } = FORWARDED_VECTOR;
    expect(await signForwardedAddress(proxySecret, ip, ts)).toBe(signature);
    expect(await signForwardedAddress('another', '198.51.100.7', 42)).toBe(signWithNodeCrypto('another', '198.51.100.7', 42));
  });
});

describe('visitorAddress', () => {
  it('reads the first of x-forwarded-for, else x-real-ip, else nothing', () => {
    expect(visitorAddress(new Headers({ 'x-forwarded-for': ' 203.0.113.9 , 10.0.0.1' }))).toBe('203.0.113.9');
    expect(visitorAddress(new Headers({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
    expect(visitorAddress(new Headers())).toBe('');
  });
});

describe('createCollectRoute, into the real collector', () => {
  it("stores the visitor's own address, signed, and the browser's own agent", async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET, fetch: recordingFetch });
    const answer = await POST(beacon(browser));
    expect(answer.status).toBe(202);
    await expect.poll(() => stored().length).toBe(1);
    const rows = stored();
    expect(rows[0]).toMatchObject({ type: 'pageview', path: '/pricing', ip: '203.0.113.9', ua: { browser: 'Chrome' } });
  });

  it('forwards the browser headers and the hints, and never a cookie or an authorization', async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET, fetch: recordingFetch });
    await POST(beacon(browser));
    const sent = outgoing[0] as Headers;
    expect(sent.get('origin')).toBe('https://next.example');
    expect(sent.get('user-agent')).toBe(CHROME);
    expect(sent.get('sec-ch-ua-mobile')).toBe('?0');
    expect(sent.get('x-chokh-forwarded-for')).toBe('203.0.113.9');
    expect(sent.get('x-chokh-forwarded-sig')).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('referer')).toBeNull();
  });

  it('a wrong secret is not believed: the collector stores its own peer, and still the row', async () => {
    const POST = createCollectRoute({ url: base, proxySecret: 'not-the-secret' });
    expect((await POST(beacon(browser, '/wrong-secret'))).status).toBe(202);
    await expect.poll(() => stored().length).toBe(1);
    const rows = stored();
    expect(rows[0]?.ip).not.toBe('203.0.113.9');
  });

  it('without a secret, sends no address at all', async () => {
    const POST = createCollectRoute({ url: base, fetch: recordingFetch });
    await POST(beacon(browser, '/no-secret'));
    expect(outgoing[0]?.get('x-chokh-forwarded-for')).toBeNull();
    await expect.poll(() => stored().length).toBe(1);
  });

  it("passes the collector's refusal through: a page of another site is 403", async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET });
    const answer = await POST(beacon({ ...browser, origin: 'https://elsewhere.example' }));
    expect(answer.status).toBe(403);
    expect(stored()).toHaveLength(0);
  });

  it('sends Referer only when there is no Origin', async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET, fetch: recordingFetch });
    const { origin: _origin, ...noOrigin } = browser;
    await POST(beacon({ ...noOrigin, referer: 'https://next.example/pricing?ref=x' }, '/no-origin'));
    expect(outgoing[0]?.get('referer')).toBe('https://next.example/pricing?ref=x');
    await expect.poll(() => stored().length).toBe(1);
  });

  it('answers 202 and forwards nothing with no Chokh URL', async () => {
    const POST = createCollectRoute({ url: undefined, fetch: recordingFetch });
    expect((await POST(beacon(browser))).status).toBe(202);
    expect(outgoing).toEqual([]);
  });

  it('answers 202 and never throws when the collector is down', async () => {
    const POST = createCollectRoute({ url: 'http://127.0.0.1:9', proxySecret: SECRET, timeoutMs: 2_000 });
    expect((await POST(beacon(browser))).status).toBe(202);
  });
});

describe('where the address comes from', () => {
  // A visitor can send any x-forwarded-for they like. On a host that passes it
  // through or appends to it, the first entry is theirs to choose, and the
  // route's signature would make the collector believe it.
  const forged = { ...browser, 'x-forwarded-for': '6.6.6.6' };

  it('behind Cloudflare, reads CF-Connecting-IP and ignores a forged x-forwarded-for', async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET, clientAddress: addressFrom.cloudflare });
    await POST(beacon({ ...forged, 'cf-connecting-ip': '203.0.113.50' }, '/behind-cloudflare'));
    await expect.poll(() => stored().length).toBe(1);
    expect(stored()[0]?.ip).toBe('203.0.113.50');
  });

  it("behind an appending proxy, reads the last entry, the address that proxy saw", async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET, clientAddress: addressFrom.lastForwardedFor });
    await POST(beacon({ ...browser, 'x-forwarded-for': '6.6.6.6, 198.51.100.20' }, '/behind-nginx'));
    await expect.poll(() => stored().length).toBe(1);
    expect(stored()[0]?.ip).toBe('198.51.100.20');
  });

  it('reads a header of your own proxy', async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET, clientAddress: addressFrom.header('x-real-ip') });
    await POST(beacon({ ...forged, 'x-real-ip': '192.0.2.77' }, '/own-header'));
    await expect.poll(() => stored().length).toBe(1);
    expect(stored()[0]?.ip).toBe('192.0.2.77');
  });

  it('the default trusts the first entry, which is why it is only for a host that overwrites it', async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET });
    await POST(beacon(forged, '/default-reader'));
    await expect.poll(() => stored().length).toBe(1);
    expect(stored()[0]?.ip).toBe('6.6.6.6');
  });

  it('signs nothing when the reader knows nothing, or throws', async () => {
    const nothing = createCollectRoute({ url: base, proxySecret: SECRET, fetch: recordingFetch, clientAddress: () => undefined });
    await nothing(beacon(browser, '/reader-nothing'));
    const throwing = createCollectRoute({
      url: base,
      proxySecret: SECRET,
      fetch: recordingFetch,
      clientAddress: () => {
        throw new Error('no header');
      },
    });
    expect((await throwing(beacon(browser, '/reader-throws'))).status).toBe(202);
    expect(outgoing.map((headers) => headers.get('x-chokh-forwarded-for'))).toEqual([null, null]);
    await expect.poll(() => stored().length).toBe(2);
  });

  it('keeps visitorAddress answering as it did', () => {
    expect(visitorAddress(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(visitorAddress(new Headers())).toBe('');
  });
});

describe('the size of a beacon', () => {
  it('forwards nothing larger than maxBodyBytes, by its declared length or its real one', async () => {
    const POST = createCollectRoute({ url: base, proxySecret: SECRET, fetch: recordingFetch, maxBodyBytes: 64 });
    expect((await POST(beacon(browser, '/far-too-long-a-path-for-sixty-four-bytes'))).status).toBe(202);
    expect(outgoing).toEqual([]);
  });
});
