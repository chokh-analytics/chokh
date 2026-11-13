import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ChokhError, createClient, type ChokhClientOptions, type ChokhDrop } from './index.js';

// Every case here posts to the real Chokh server: packages/server's own buildApp
// on its in-memory store, listening on a free port, with a write:events key minted
// through its own API. What a case reads back is what the route stored, so a
// client that sent the wrong shape, the wrong header or the wrong path fails here
// rather than in somebody's production.
//
// The failures a client has to survive (a 503, a reset connection, a server that
// never answers) are not things the real server does on request, so a small proxy
// sits in front of it and fails the requests a case tells it to, then passes the
// rest through. The retried request is still stored by the real route.
//
// No case waits on real backoff, and none reads the hour or the day: the waits
// are recorded through the client's sleep seam, and every timestamp a case
// asserts is one it chose.

process.env.LOG_LEVEL = 'silent';
process.env.SESSION_SECRET ??= 'chokh-sdk-node-test-session-secret';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = 's_sdk';
const execFileAsync = promisify(execFile);

interface StoredRow {
  type: string;
  name?: string;
  userId?: string;
  visitorId: string;
  ts: number;
  path?: string;
  value?: number;
  props?: Record<string, string>;
  traits?: Record<string, string>;
  source?: string;
}

interface Real {
  url: string;
  token: string;
  readOnlyToken: string;
  stored(): StoredRow[];
  clear(): void;
  close(): Promise<void>;
}

async function startRealServer(): Promise<Real> {
  const { buildApp } = await import('@chokh/server/app');
  const { createMemoryStore } = await import('@chokh/server/store/memory');
  const store = createMemoryStore([]);
  const app = await buildApp({ store });
  await app.ready();

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'owner@sdk.test', password: 'a-password-long-enough' },
  });
  expect(register.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@sdk.test', password: 'a-password-long-enough' },
  });
  const cookie = login.cookies[0];
  if (cookie === undefined) throw new Error('no session cookie');
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const site = await app.inject({
    method: 'POST',
    url: '/api/sites',
    headers,
    payload: { id: SITE, name: 'SDK test site', domains: ['sdk.example'] },
  });
  expect(site.statusCode).toBe(201);

  async function mint(scopes: string[]): Promise<string> {
    const key = await app.inject({
      method: 'POST',
      url: `/api/sites/${SITE}/keys`,
      headers,
      payload: { name: scopes.join(' '), scopes },
    });
    expect(key.statusCode).toBe(201);
    return (JSON.parse(key.body) as { data: { once: { token: string } } }).data.once.token;
  }

  const token = await mint(['write:events']);
  const readOnlyToken = await mint(['read:stats']);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  let seenBefore = 0;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    readOnlyToken,
    // Only what arrived since the last clear(). The store's own clear() would
    // take the account and the keys with it.
    stored: () =>
      store
        .stored()
        .slice(seenBefore)
        .filter((row) => row.siteId === SITE) as unknown as StoredRow[],
    clear: () => {
      seenBefore = store.stored().length;
    },
    close: () => app.close(),
  };
}

// What the proxy does with the next request it receives.
type Act = 'pass' | '503' | 'reset' | 'hang';

interface Proxy {
  url: string;
  plan: Act[];
  seen: { act: Act; body: { userId: string; visitorId?: string; events: unknown[] } }[];
  close(): Promise<void>;
}

async function startProxy(upstream: string): Promise<Proxy> {
  const hanging: ServerResponse[] = [];
  const proxy: Proxy = { url: '', plan: [], seen: [], close: async () => undefined };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const act = proxy.plan.shift() ?? 'pass';
    proxy.seen.push({ act, body: JSON.parse(body.toString('utf8')) as Proxy['seen'][number]['body'] });
    if (act === 'reset') {
      request.socket.destroy();
      return;
    }
    if (act === 'hang') {
      hanging.push(response);
      return;
    }
    if (act === '503') {
      response.writeHead(503, { 'content-type': 'text/html' });
      response.end('<html><body>Service Unavailable</body></html>');
      return;
    }
    const answer = await fetch(`${upstream}${request.url ?? '/'}`, {
      method: request.method ?? 'POST',
      headers: {
        'content-type': String(request.headers['content-type'] ?? 'application/json'),
        authorization: String(request.headers.authorization ?? ''),
      },
      body,
    });
    response.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
    response.end(Buffer.from(await answer.arrayBuffer()));
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  proxy.close = async () => {
    for (const response of hanging) response.socket?.destroy();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return proxy;
}

let real: Real;
let proxy: Proxy;
let drops: ChokhDrop[];
let waits: number[];

beforeAll(async () => {
  real = await startRealServer();
  proxy = await startProxy(real.url);
});

afterAll(async () => {
  await proxy.close();
  await real.close();
});

beforeEach(() => {
  real.clear();
  proxy.plan = [];
  proxy.seen = [];
  drops = [];
  waits = [];
});

const clients: { shutdown(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.shutdown();
});

// A client through the proxy, its drops and waits recorded, and nothing sent
// until a case says so unless it asks for a smaller flushAt or interval.
function client(overrides: Partial<ChokhClientOptions> = {}) {
  const made = createClient({
    url: proxy.url,
    siteId: SITE,
    apiKey: real.token,
    onDrop: (drop) => drops.push(drop),
    flushAt: 1_000,
    flushIntervalMs: 60_000,
    flushOnExit: false,
    sleep: async (ms) => {
      waits.push(ms);
    },
    // The top of each jitter window, so a recorded wait is the ceiling.
    random: () => 0.999_999,
    ...overrides,
  });
  clients.push(made);
  return made;
}

describe('track and identify, queued and batched per person', () => {
  it('stores what was tracked, one request per person, in the order it was tracked', async () => {
    const chokh = client();
    chokh.identify('u_1', { plan: 'pro', seats: 3, trial: false, empty: undefined });
    chokh.track('u_1', 'order_paid', { value: 1200, path: '/checkout', props: { currency: 'BDT' } });
    chokh.track('u_2', 'signup');
    chokh.track('u_1', 'invoice_sent');
    expect(chokh.pending()).toBe(4);

    const result = await chokh.flush();

    expect(result).toEqual({ sent: 4, dropped: 0 });
    expect(proxy.seen.map((request) => [request.body.userId, request.body.events.length])).toEqual([
      ['u_1', 3],
      ['u_2', 1],
    ]);
    // The order each request carried, which is the order of the calls.
    expect(proxy.seen.flatMap((request) => request.body.events.map((event) => (event as { type: string; name?: string }).name ?? (event as { type: string }).type))).toEqual([
      'identify',
      'order_paid',
      'invoice_sent',
      'signup',
    ]);
    const rows = real.stored();
    // The store keeps rows in time order, which is not a thing this asserts.
    expect(rows.map((row) => `${row.userId} ${row.type} ${row.name ?? '-'}`).sort()).toEqual([
      'u_1 event invoice_sent',
      'u_1 event order_paid',
      'u_1 identify -',
      'u_2 event signup',
    ]);
    // A number and a boolean are written as strings, an empty trait left out.
    expect(rows.find((row) => row.type === 'identify')?.traits).toEqual({ plan: 'pro', seats: '3', trial: 'false' });
    expect(rows.find((row) => row.name === 'order_paid')).toMatchObject({ value: 1200, path: '/checkout', props: { currency: 'BDT' }, source: 'server' });
    expect(drops).toEqual([]);
  });

  it('carries the moment of the call, not the moment of the send', async () => {
    let at = 1_000;
    const chokh = client({ now: () => at });
    chokh.track('u_1', 'clicked');
    at = 9_000;
    await chokh.flush();
    expect(proxy.seen[0]?.body.events).toEqual([{ type: 'event', name: 'clicked', ts: 1_000 }]);
  });

  it('keeps a visitorId apart from the same person without one, and lands on that visitor', async () => {
    const chokh = client();
    chokh.track('u_1', 'in_browser', { visitorId: 'v_browser' });
    chokh.track('u_1', 'server_only');
    await chokh.flush();
    expect(proxy.seen.map((request) => request.body.visitorId)).toEqual(['v_browser', undefined]);
    expect(real.stored().find((row) => row.name === 'in_browser')?.visitorId).toBe('v_browser');
  });

  it('never puts more than 50 events in a request', async () => {
    const chokh = client();
    for (let i = 0; i < 120; i += 1) chokh.track('u_1', `e_${i}`);
    expect(await chokh.flush()).toEqual({ sent: 120, dropped: 0 });
    expect(proxy.seen.map((request) => request.body.events.length)).toEqual([50, 50, 20]);
    expect(real.stored().map((row) => row.name)).toEqual(Array.from({ length: 120 }, (_, i) => `e_${i}`));
  });

  it('starts a flush by itself once flushAt events are queued', async () => {
    const chokh = client({ flushAt: 3 });
    chokh.track('u_1', 'a');
    chokh.track('u_1', 'b');
    expect(proxy.seen).toHaveLength(0);
    chokh.track('u_1', 'c');
    await expect.poll(() => real.stored().length).toBe(3);
    expect(proxy.seen).toHaveLength(1);
  });

  it('starts a flush by itself flushIntervalMs after the first event', async () => {
    const chokh = client({ flushIntervalMs: 30 });
    chokh.track('u_1', 'only_one');
    await expect.poll(() => real.stored().length).toBe(1);
  });

  it('drops an event outside the route limits alone, and sends the rest', async () => {
    const chokh = client();
    chokh.track('u_1', 'fine');
    chokh.track('u_1', 'x'.repeat(121));
    chokh.track('u_1', 'too_many', { props: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, 'v'])) });
    chokh.track('', 'nobody');
    chokh.track('u_1', 'nan', { value: Number.NaN });
    chokh.identify('u_1', { long: 'y'.repeat(513) });
    chokh.track('u_1', 'also_fine');

    expect(await chokh.flush()).toEqual({ sent: 2, dropped: 0 });

    expect(real.stored().map((row) => row.name)).toEqual(['fine', 'also_fine']);
    expect(drops.map((drop) => [drop.reason, drop.message])).toEqual([
      ['invalid', 'the event name is not 1 to 120 characters'],
      ['invalid', 'more than 40 properties'],
      ['invalid', 'userId is not a string of 1 to 200 characters'],
      ['invalid', 'the value is not a finite number'],
      ['invalid', 'trait "long" is longer than 512 characters'],
    ]);
  });

  it('holds at most maxQueueSize events and drops the oldest to make room', async () => {
    const chokh = client({ maxQueueSize: 3 });
    for (const name of ['one', 'two', 'three', 'four', 'five']) chokh.track('u_1', name);
    expect(chokh.pending()).toBe(3);
    expect(drops.map((drop) => [drop.reason, (drop.events[0]?.event.name)])).toEqual([
      ['queue_full', 'one'],
      ['queue_full', 'two'],
    ]);
    await chokh.flush();
    expect(real.stored().map((row) => row.name)).toEqual(['three', 'four', 'five']);
  });
});

describe('retries', () => {
  it('retries a 5xx with backoff, and the real route stores the request once', async () => {
    proxy.plan = ['503', '503'];
    const chokh = client();
    chokh.track('u_1', 'order_paid');
    expect(await chokh.flush()).toEqual({ sent: 1, dropped: 0 });
    expect(proxy.seen.map((request) => request.act)).toEqual(['503', '503', 'pass']);
    // Full jitter under a ceiling that doubles from 500 ms.
    expect(waits).toEqual([499, 999]);
    expect(real.stored()).toHaveLength(1);
  });

  it('retries a connection that was reset', async () => {
    proxy.plan = ['reset'];
    const chokh = client();
    chokh.track('u_1', 'order_paid');
    expect(await chokh.flush()).toEqual({ sent: 1, dropped: 0 });
    expect(proxy.seen.map((request) => request.act)).toEqual(['reset', 'pass']);
    expect(real.stored()).toHaveLength(1);
  });

  it('retries a request that timed out', async () => {
    proxy.plan = ['hang'];
    const chokh = client({ timeoutMs: 100 });
    chokh.track('u_1', 'order_paid');
    expect(await chokh.flush()).toEqual({ sent: 1, dropped: 0 });
    expect(proxy.seen.map((request) => request.act)).toEqual(['hang', 'pass']);
  });

  it('gives up after maxRetries and says so, with the backoff capped at retryMaxMs', async () => {
    proxy.plan = ['503', '503', '503', '503', '503', '503', '503'];
    const chokh = client({ retryMaxMs: 3_000 });
    chokh.track('u_1', 'order_paid');
    expect(await chokh.flush()).toEqual({ sent: 0, dropped: 1 });
    expect(proxy.seen).toHaveLength(6);
    expect(waits).toEqual([499, 999, 1999, 2999, 2999]);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ reason: 'retries_exhausted' });
    expect(drops[0]?.error).toBeInstanceOf(ChokhError);
    expect(drops[0]?.error?.status).toBe(503);
    expect(real.stored()).toHaveLength(0);
  });

  it('never retries a 4xx: a key without write:events is refused once and its events dropped', async () => {
    const chokh = client({ apiKey: real.readOnlyToken });
    chokh.track('u_1', 'order_paid');
    expect(await chokh.flush()).toEqual({ sent: 0, dropped: 1 });
    expect(proxy.seen).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(drops[0]).toMatchObject({ reason: 'rejected', error: { status: 403 } });
  });

  it('never retries a 401 either, and the next person still goes', async () => {
    const wrong = client({ apiKey: 'chk_not_a_key' });
    wrong.track('u_1', 'order_paid');
    await wrong.flush();
    expect(drops[0]).toMatchObject({ reason: 'rejected', error: { status: 401 } });
    expect(proxy.seen).toHaveLength(1);

    const right = client();
    right.track('u_2', 'order_paid');
    await right.flush();
    expect(real.stored().map((row) => row.userId)).toEqual(['u_2']);
  });

  it('holds the queue in order behind a retrying request, then sends it all', async () => {
    proxy.plan = ['503'];
    const chokh = client();
    chokh.track('u_1', 'first');
    chokh.track('u_2', 'second');
    await chokh.flush();
    expect(real.stored().map((row) => row.name)).toEqual(['first', 'second']);
  });
});

describe('flush and shutdown', () => {
  it('reports what a flush sent and dropped, and never rejects', async () => {
    proxy.plan = ['503', '503', '503', '503', '503', '503'];
    const chokh = client();
    chokh.track('u_1', 'lost');
    chokh.track('u_2', 'kept');
    await expect(chokh.flush()).resolves.toEqual({ sent: 1, dropped: 1 });
  });

  it('shutdown sends what is queued, then refuses new events', async () => {
    const chokh = client();
    chokh.track('u_1', 'before');
    expect(await chokh.shutdown()).toEqual({ sent: 1, dropped: 0 });
    chokh.track('u_1', 'after');
    expect(chokh.pending()).toBe(0);
    expect(drops.map((drop) => drop.reason)).toEqual(['shutdown']);
    expect(real.stored().map((row) => row.name)).toEqual(['before']);
  });

  it('shutdown gives up after shutdownTimeoutMs and drops what is left', async () => {
    proxy.plan = ['hang'];
    const chokh = client({ shutdownTimeoutMs: 150, timeoutMs: 10_000, sleep: undefined });
    chokh.track('u_1', 'in_flight');
    chokh.track('u_2', 'never_sent');
    const started = performance.now();
    const result = await chokh.shutdown();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ sent: 0, dropped: 2 });
    expect(drops.map((drop) => [drop.reason, drop.events.map((item) => item.event.name)])).toEqual([
      ['shutdown', ['in_flight']],
      ['shutdown', ['never_sent']],
    ]);
  });

  it('the default reporter writes one warning line and does not throw', async () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => lines.push(line);
    try {
      const chokh = createClient({ url: proxy.url, siteId: SITE, apiKey: real.token, flushOnExit: false });
      clients.push(chokh);
      chokh.track('u_1', '');
    } finally {
      console.warn = original;
    }
    expect(lines).toEqual(['chokh: dropped 1 event (invalid): the event name is not 1 to 120 characters']);
  });

  it('a process that ends with events queued sends them on its way out', async () => {
    const built = resolve(HERE, '..', 'dist', 'esm', 'index.js');
    expect(existsSync(built), 'build the package first: pnpm --filter @chokh/sdk-node build').toBe(true);
    const script = [
      `import { createClient } from ${JSON.stringify(new URL(`file:///${built.replace(/\\/g, '/')}`).href)};`,
      `const chokh = createClient({ url: ${JSON.stringify(real.url)}, siteId: ${JSON.stringify(SITE)}, apiKey: ${JSON.stringify(real.token)}, flushIntervalMs: 60000 });`,
      `chokh.track('u_exit', 'last_words');`,
      // Nothing awaited and no timer holding the loop: without the beforeExit
      // flush this process would end with the event still queued.
    ].join('\n');
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { timeout: 20_000 });
    expect(real.stored().map((row) => [row.userId, row.name])).toEqual([['u_exit', 'last_words']]);
  });
});

describe('send, one request now', () => {
  it('answers with the visitor the events landed on', async () => {
    const chokh = client();
    const result = await chokh.send({ userId: 'u_9', events: [{ type: 'event', name: 'refund' }] });
    expect(result).toEqual({ accepted: 1, visitorId: 'u:u_9' });
  });

  it('raises the code the server refused with, not a bare status', async () => {
    const chokh = client({ apiKey: real.readOnlyToken });
    await expect(chokh.send({ userId: 'u_9', events: [{ type: 'event', name: 'refund' }] })).rejects.toMatchObject({
      name: 'ChokhError',
      status: 403,
      code: expect.stringMatching(/^[A-Z_]+$/),
    });
  });
});
