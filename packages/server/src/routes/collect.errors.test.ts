import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { defaultSiteSettings, type Site } from '../store/AnalyticsStore.js';
import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';

// The collector's half of AN-VIT01: what e.js and v.js post through a.js, read
// back out of the rows and out of the health reports, so a field renamed on the
// wire breaks a test rather than a dashboard. Errors arrive only for a site that
// turned capture on, scrubbed before the row exists, the stack only where the
// site keeps stacks, and no more than ten per visitor in a minute.

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function site(id: string, settings: Partial<Site['settings']>): Site {
  return {
    id,
    name: id,
    domains: [`${id}.test`],
    settings: defaultSiteSettings({ visitorIdMode: 'persistent', ...settings }),
  };
}

const OFF = site('errors_off', {});
const ON = site('errors_on', { errorCapture: true });
const STACKS = site('errors_stacks', { errorCapture: true, errorStacks: true });

let store: MemoryStore;
let app: FastifyInstance;

beforeEach(async () => {
  store = createMemoryStore([OFF, ON, STACKS]);
  app = await buildApp({ store });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function post(siteId: string, events: unknown[], visitorId = 'visitor_1'): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/collect',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      origin: `https://${siteId}.test`,
      'user-agent': CHROME,
    },
    payload: JSON.stringify({ siteId, sentAt: Date.now(), hostname: `${siteId}.test`, visitorId, events }),
  });
  return response.statusCode;
}

function error(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'error',
    ts: Date.now() - 1000,
    path: '/account/reset?token=abc123#top',
    name: 'Error: no account for rafi@example.com',
    frame: 'https://cdn.test/app.js?v=9:12:4',
    stack: 'Error: no account for rafi@example.com\n    at reset (https://cdn.test/app.js?v=9:12:4)',
    ...over,
  };
}

describe('POST /api/collect with errors', () => {
  it('drops an error for a site that has not turned capture on, and keeps the rest of the batch', async () => {
    expect(await post(OFF.id, [{ type: 'pageview', ts: Date.now() - 2000, path: '/' }, error()])).toBe(202);
    expect(store.stored().map((event) => event.type)).toEqual(['pageview']);
  });

  it('keeps a scrubbed error without its stack by default', async () => {
    expect(await post(ON.id, [error()])).toBe(202);
    const [row] = store.stored();
    expect(row).toMatchObject({
      type: 'error',
      name: 'Error: no account for [email]',
      path: '/account/reset',
      frame: 'https://cdn.test/app.js:12:4',
    });
    expect(row?.stack).toBeUndefined();
  });

  it('keeps the scrubbed stack where the site keeps stacks, cut to 1,000 characters', async () => {
    const long = `Error: boom\n${'    at f (https://cdn.test/a.js?s=1:1:1)\n'.repeat(150)}`;
    expect(await post(STACKS.id, [error(), error({ name: 'Error: boom', stack: long })])).toBe(202);
    const [first, second] = store.stored();
    expect(first?.stack).toBe(
      'Error: no account for [email]\n    at reset (https://cdn.test/app.js:12:4)',
    );
    expect(second?.stack).toHaveLength(1000);
    expect(second?.stack).not.toContain('?s=1');
  });

  it('keeps ten errors per visitor in a minute and drops the rest', async () => {
    const twelve = Array.from({ length: 12 }, (_, at) => error({ name: `Error ${at}` }));
    expect(await post(ON.id, twelve)).toBe(202);
    expect(store.stored()).toHaveLength(10);
    // Another visitor has their own ten.
    expect(await post(ON.id, [error()], 'visitor_2')).toBe(202);
    expect(store.stored()).toHaveLength(11);
  });

  it('refuses a type nobody sends, the way it always has', async () => {
    expect(await post(ON.id, [{ type: 'crash', ts: Date.now() }])).toBe(400);
  });

  it('reaches the errors report grouped by message with its page and browser', async () => {
    await post(ON.id, [error(), error({ ts: Date.now() - 500 })]);
    await post(ON.id, [error({ name: 'TypeError: a is undefined', path: '/b' })], 'visitor_2');
    const report = await store.errors({ siteId: ON.id, from: Date.now() - 60_000, to: Date.now() + 1 });
    expect(report.groups.map((group) => [group.message, group.count, group.visitors])).toEqual([
      ['Error: no account for [email]', 2, 1],
      ['TypeError: a is undefined', 1, 1],
    ]);
    expect(report.groups[0]?.pages).toEqual([{ page: '/account/reset', count: 2 }]);
    expect(report.groups[0]?.browsers).toEqual([{ browser: 'Chrome', count: 2 }]);
  });
});

describe('POST /api/collect with vitals', () => {
  it('reaches the vitals report at p75 with the device the collector read', async () => {
    const now = Date.now();
    const events = Array.from({ length: 20 }, (_, at) => ({
      type: 'vital',
      ts: now - 10_000 + at,
      path: '/',
      name: 'LCP',
      value: 1000 + at * 100,
      rating: 'good',
    }));
    // Two batches of ten, the way a.js would send them over a few pages.
    expect(await post(OFF.id, events.slice(0, 10))).toBe(202);
    expect(await post(OFF.id, events.slice(10), 'visitor_2')).toBe(202);
    const report = await store.vitals({ siteId: OFF.id, from: now - 60_000, to: now + 1 });
    expect(report.metrics[0]).toMatchObject({ metric: 'LCP', p75: 2400, samples: 20, rating: 'good' });
    expect(report.metrics[0]?.devices).toEqual([
      { device: 'desktop', p75: 2400, samples: 20, rating: 'good' },
    ]);
  });
});
