import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ChokhError, createClient, type ChokhClientOptions, type ChokhDrop } from './index.js';
import { retryAfterMs } from './client.js';

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

// What the proxy does with a request: pass it to the real server, answer for
// it, or lose it. 'hold' passes it once release() is called; 'stored-reset'
// passes it and then drops the connection before the answer, so the server
// has stored it and the client never hears so.
type Act = 'pass' | '503' | '408' | '429' | 'reset' | 'hang' | 'hold' | 'stored-reset';

interface Seen {
  act: Act;
  body: { userId: string; visitorId?: string; events: unknown[] };
}

interface Proxy {
  url: string;
  // The next requests, in arrival order, unless the person has a plan of their own.
  plan: Act[];
  byUser: Map<string, Act[]>;
  // What a 429 or a 408 says in Retry-After, when anything.
  retryAfter: string | undefined;
  seen: Seen[];
  // The most requests in flight at once, overall and for any one person.
  maxInFlight: number;
  maxInFlightPerUser: number;
  // Lets every held request through.
  release(): void;
  // Every request may take a little while: a delay in ms chosen per request.
  delay: (index: number) => number;
  close(): Promise<void>;
}

async function startProxy(upstream: string): Promise<Proxy> {
  const hanging: ServerResponse[] = [];
  let releaseHeld: () => void = () => undefined;
  let held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const inFlight = new Map<string, number>();
  let total = 0;
  const proxy: Proxy = {
    url: '',
    plan: [],
    byUser: new Map(),
    retryAfter: undefined,
    seen: [],
    maxInFlight: 0,
    maxInFlightPerUser: 0,
    release: () => {
      releaseHeld();
      held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
    },
    delay: () => 0,
    close: async () => undefined,
  };

  async function forward(request: IncomingMessage, body: Buffer): Promise<Response> {
    return fetch(`${upstream}${request.url ?? '/'}`, {
      method: request.method ?? 'POST',
      headers: {
        'content-type': String(request.headers['content-type'] ?? 'application/json'),
        authorization: String(request.headers.authorization ?? ''),
      },
      body,
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const parsed = JSON.parse(body.toString('utf8')) as Seen['body'];
    const act = proxy.byUser.get(parsed.userId)?.shift() ?? proxy.plan.shift() ?? 'pass';
    const index = proxy.seen.length;
    proxy.seen.push({ act, body: parsed });

    const mine = (inFlight.get(parsed.userId) ?? 0) + 1;
    inFlight.set(parsed.userId, mine);
    total += 1;
    proxy.maxInFlight = Math.max(proxy.maxInFlight, total);
    proxy.maxInFlightPerUser = Math.max(proxy.maxInFlightPerUser, mine);
    const done = (): void => {
      inFlight.set(parsed.userId, (inFlight.get(parsed.userId) ?? 1) - 1);
      total -= 1;
    };

    const pause = proxy.delay(index);
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));

    if (act === 'reset') {
      done();
      request.socket.destroy();
      return;
    }
    if (act === 'hang') {
      done();
      hanging.push(response);
      return;
    }
    if (act === '503' || act === '408' || act === '429') {
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (act !== '503' && proxy.retryAfter !== undefined) headers['retry-after'] = proxy.retryAfter;
      response.writeHead(Number(act), headers);
      response.end('<html><body>Try again later</body></html>');
      done();
      return;
    }
    if (act === 'hold') await held;
    const answer = await forward(request, body);
    const answerBody = Buffer.from(await answer.arrayBuffer());
    done();
    if (act === 'stored-reset') {
      request.socket.destroy();
      return;
    }
    response.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
    response.end(answerBody);
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  proxy.close = async () => {
    releaseHeld();
    for (const response of hanging) response.socket?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
  proxy.byUser = new Map();
  proxy.retryAfter = undefined;
  proxy.delay = () => 0;
  proxy.maxInFlight = 0;
  proxy.maxInFlightPerUser = 0;
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

  it('holds one person behind their own retrying request, and sends it all', async () => {
    proxy.byUser.set('u_1', ['503']);
    const chokh = client();
    chokh.track('u_1', 'first');
    chokh.track('u_2', 'second');
    chokh.track('u_1', 'third');
    await chokh.flush();
    expect(real.stored().map((row) => row.name).sort()).toEqual(['first', 'second', 'third']);
    // u_1's two events ride in one request, sent again after the 503; u_2's
    // went once, beside it.
    expect(proxy.seen.filter((request) => request.body.userId === 'u_1').map((request) => [request.act, request.body.events.length])).toEqual([
      ['503', 2],
      ['pass', 2],
    ]);
    expect(proxy.seen.filter((request) => request.body.userId === 'u_2')).toHaveLength(1);
  });
});

describe('flush and shutdown', () => {
  it('reports what a flush sent and dropped, and never rejects', async () => {
    proxy.byUser.set('u_1', ['503', '503', '503', '503', '503', '503']);
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
    // One slot, so the second person is still queued when time runs out.
    proxy.plan = ['hang'];
    const chokh = client({ shutdownTimeoutMs: 150, timeoutMs: 10_000, sleep: undefined, concurrency: 1 });
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

describe('requests in flight at once', () => {
  it('sends several people at once, never two requests for one person, each person in order', async () => {
    // Every request takes 0 to 20 ms, decided by its position, so they overlap.
    proxy.delay = (index) => (index * 7) % 21;
    const chokh = client({ concurrency: 3 });
    const people = ['u_a', 'u_b', 'u_c', 'u_d'];
    // u_a first and in bulk: three requests' worth at the head of the queue,
    // which is when a free slot would start a second request for u_a if the
    // rule let it. Then the others, interleaved.
    for (let i = 0; i < 120; i += 1) chokh.track('u_a', `u_a_${String(i).padStart(3, '0')}`);
    for (let i = 0; i < 120; i += 1) {
      for (const person of people.slice(1)) chokh.track(person, `${person}_${String(i).padStart(3, '0')}`);
    }
    expect(await chokh.flush()).toEqual({ sent: 480, dropped: 0 });

    expect(proxy.maxInFlight).toBe(3);
    expect(proxy.maxInFlightPerUser).toBe(1);
    for (const person of people) {
      const sent = proxy.seen
        .filter((request) => request.body.userId === person)
        .flatMap((request) => request.body.events.map((event) => (event as { name: string }).name));
      expect(sent).toEqual(Array.from({ length: 120 }, (_, i) => `${person}_${String(i).padStart(3, '0')}`));
    }
    expect(real.stored()).toHaveLength(480);
  });

  it('does not let one slow person hold the others back', async () => {
    proxy.byUser.set('u_slow', ['hold']);
    const chokh = client();
    chokh.track('u_slow', 'waiting');
    const flushed = chokh.flush();
    await expect.poll(() => proxy.seen.length).toBe(1);
    chokh.track('u_quick', 'one');
    chokh.track('u_other', 'two');
    // Tracked while the slow request is still open, and stored all the same.
    await expect.poll(() => real.stored().map((row) => row.name).sort()).toEqual(['one', 'two']);
    proxy.release();
    expect(await flushed).toEqual({ sent: 3, dropped: 0 });
    expect(real.stored().map((row) => row.name).sort()).toEqual(['one', 'two', 'waiting']);
  });

  it('with concurrency 1, sends one request at a time', async () => {
    proxy.delay = () => 5;
    const chokh = client({ concurrency: 1 });
    for (const person of ['u_1', 'u_2', 'u_3']) chokh.track(person, 'x');
    await chokh.flush();
    expect(proxy.maxInFlight).toBe(1);
  });
});

describe('the 4xx that mean again later', () => {
  it('retries a 429, waiting what Retry-After asks', async () => {
    proxy.plan = ['429'];
    proxy.retryAfter = '2';
    const chokh = client();
    chokh.track('u_1', 'throttled');
    expect(await chokh.flush()).toEqual({ sent: 1, dropped: 0 });
    expect(waits).toEqual([2_000]);
    expect(proxy.seen.map((request) => request.act)).toEqual(['429', 'pass']);
  });

  it('waits no longer than retryMaxMs, whatever Retry-After asks', async () => {
    proxy.plan = ['429'];
    proxy.retryAfter = '3600';
    const chokh = client({ retryMaxMs: 5_000 });
    chokh.track('u_1', 'throttled');
    await chokh.flush();
    expect(waits).toEqual([5_000]);
  });

  it('retries a 408 like a 5xx', async () => {
    proxy.plan = ['408'];
    const chokh = client();
    chokh.track('u_1', 'slow');
    expect(await chokh.flush()).toEqual({ sent: 1, dropped: 0 });
    expect(waits).toEqual([499]);
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(retryAfterMs('2', 0)).toBe(2_000);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:10 GMT', 4_000)).toBe(6_000);
    expect(retryAfterMs('soon', 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });
});

describe('a caller TypeScript does not check', () => {
  // As a CommonJS or plain JavaScript caller would call it.
  const loose = (chokh: ReturnType<typeof client>) =>
    chokh as unknown as {
      track(...args: unknown[]): void;
      identify(...args: unknown[]): void;
    };

  it('takes null options as none', async () => {
    const chokh = client();
    expect(() => loose(chokh).track('u_1', 'with_null', null)).not.toThrow();
    expect(() => loose(chokh).identify('u_1', null, null)).not.toThrow();
    expect(await chokh.flush()).toEqual({ sent: 2, dropped: 0 });
  });

  it('drops a value of the wrong type alone, before it can fail a request', async () => {
    const chokh = client();
    const call = loose(chokh);
    call.track('u_1', 'fine');
    call.track('u_1', 'path_number', { path: 5 });
    call.track('u_1', 'props_array', { props: ['a'] });
    call.track('u_1', 'props_object_value', { props: { plan: { tier: 'pro' } } });
    call.track('u_1', 'value_string', { value: '12' });
    call.track('u_1', 'options_string', 'oops');
    call.track('u_1', 'visitor_number', { visitorId: 7 });
    call.identify('u_1', 'traits as a string');
    call.identify('u_1', { ok: 'yes' }, { ts: 1.5 });
    call.track(42, 'user_number');
    call.track('u_1', 'fine_too');
    expect(await chokh.flush()).toEqual({ sent: 2, dropped: 0 });
    expect(real.stored().map((row) => row.name)).toEqual(['fine', 'fine_too']);
    expect(drops.map((drop) => drop.message)).toEqual([
      'the path is not a string of at most 1024 characters',
      'the properties are not an object',
      'property "plan" is not a string, a number or a boolean',
      'the value is not a finite number',
      'the options are not an object',
      'visitorId is not a string of 1 to 200 characters',
      'the traits are not an object',
      'ts is not an integer number of milliseconds',
      'userId is not a string of 1 to 200 characters',
    ]);
    expect(drops.every((drop) => drop.reason === 'invalid')).toBe(true);
  });

  it('turns anything that throws inside a call into an invalid drop', async () => {
    const chokh = client();
    const hostile = {
      get props(): never {
        throw new Error('a getter that throws');
      },
    };
    expect(() => loose(chokh).track('u_1', 'hostile', hostile)).not.toThrow();
    expect(drops).toEqual([expect.objectContaining({ reason: 'invalid', message: 'the event could not be read: a getter that throws' })]);
  });
});

describe('delivery is at least once', () => {
  it('stores a batch twice when the answer is lost after the server stored it, and says nothing', async () => {
    // The route has no idempotency key and the store folds no repeated server
    // event, so a retry after a lost answer is a second copy. The README says so.
    proxy.plan = ['stored-reset'];
    const chokh = client();
    chokh.track('u_1', 'paid_once');
    expect(await chokh.flush()).toEqual({ sent: 1, dropped: 0 });
    expect(real.stored().map((row) => row.name)).toEqual(['paid_once', 'paid_once']);
  });
});

describe('shutdown called twice', () => {
  it('answers both calls with the one shutdown', async () => {
    proxy.plan = ['hang'];
    const chokh = client({ shutdownTimeoutMs: 100, timeoutMs: 10_000, sleep: undefined });
    chokh.track('u_1', 'in_flight');
    const first = chokh.shutdown();
    const second = chokh.shutdown();
    expect(second).toBe(first);
    expect(await first).toEqual({ sent: 0, dropped: 1 });
    expect(drops).toHaveLength(1);
  });
});
