import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { start } from './tracker';
import type { Batch, TrackedEvent } from './types';

// start() attaches listeners to this jsdom window, so the tracker is booted once
// and the whole sequence of one visit is asserted in order.
const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { status: 202 })),
);

function collected(): TrackedEvent[] {
  return fetchMock.mock.calls
    .map((call) => JSON.parse(String(call[1]?.body)) as Batch)
    .flatMap((batch) => batch.events);
}

function settle(): void {
  vi.advanceTimersByTime(1000);
}

beforeAll(() => {
  vi.useFakeTimers();

  Object.defineProperty(window, 'fetch', { value: fetchMock, configurable: true });
  Object.defineProperty(window.navigator, 'sendBeacon', { value: undefined, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 600, configurable: true });

  const script = document.createElement('script');
  script.setAttribute('data-site', 'site_1');
  script.setAttribute('src', '/_pa/a.js');
  script.setAttribute('data-api', '/_pa');
  document.head.appendChild(script);

  window.history.replaceState({}, '', '/start');
  start(window, document);
});

afterAll(() => {
  vi.useRealTimers();
});

describe('a visit through a single page app', () => {
  it('opens with one pageview and no leave, because nothing was left yet', () => {
    settle();

    const events = collected();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('pageview');
    expect(events[0]?.path).toBe('/start');
  });

  it('closes the page it leaves before opening the next one', () => {
    vi.advanceTimersByTime(3000);
    window.history.pushState({}, '', '/courses/cp-beginners');
    settle();

    const events = collected();
    expect(events.map((event) => event.type)).toEqual(['pageview', 'leave', 'pageview']);

    const leave = events[1];
    expect(leave?.path).toBe('/start');
    expect(leave?.duration).toBeGreaterThan(0);
    expect(leave?.scrollDepth).toBe(75);

    expect(events[2]?.path).toBe('/courses/cp-beginners');
  });

  it('counts time on page from the new page, not from the visit', () => {
    vi.advanceTimersByTime(2000);
    window.dispatchEvent(new Event('pagehide'));

    const events = collected();
    const last = events[events.length - 1];
    expect(last?.type).toBe('leave');
    expect(last?.path).toBe('/courses/cp-beginners');
    expect(last?.duration).toBeLessThan(events[1]?.duration ?? 0);
  });
});

function batches(): Batch[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as Batch);
}

function lastBatch(): Batch | undefined {
  const all = batches();
  return all[all.length - 1];
}

describe('the status a page declares', () => {
  it('puts it on the pageview that follows and on no later one', () => {
    window.paStatus = 404;
    window.history.pushState({}, '', '/gone');
    settle();

    const events = collected();
    const notFound = events[events.length - 1];
    expect(notFound?.path).toBe('/gone');
    expect(notFound?.status).toBe('404');

    // Cleared on the way past, so the next page is not a 404 as well. This is
    // the whole failure mode of a global: a single page app that sets it once
    // would otherwise report every page after it as not found.
    window.history.pushState({}, '', '/found');
    settle();
    const after = collected();
    expect(after[after.length - 1]?.path).toBe('/found');
    expect(after[after.length - 1]?.status).toBeUndefined();
  });

  it('ignores anything that is not a status, rather than sending it', () => {
    window.paStatus = 'not found';
    window.history.pushState({}, '', '/junk');
    settle();

    const events = collected();
    expect(events[events.length - 1]?.path).toBe('/junk');
    expect(events[events.length - 1]?.status).toBeUndefined();
  });
});

describe('identify, and the proof a site can put behind it', () => {
  it('sends the user and the signature the site issued, on that batch and the next', () => {
    window.pa?.('identify', 'user_42', { plan: 'pro' }, 'sig-issued-by-the-server');
    settle();

    const identified = lastBatch();
    expect(identified?.userId).toBe('user_42');
    expect(identified?.sig).toBe('sig-issued-by-the-server');
    const event = identified?.events.find((one) => one.type === 'identify');
    expect(event?.userId).toBe('user_42');
    expect(event?.traits).toEqual({ plan: 'pro' });

    // The userId rides on every batch after an identify, so the proof has to
    // ride with it: the collector checks the batch, not one event in it.
    window.pa?.('event', 'quiz_start');
    settle();
    expect(lastBatch()?.userId).toBe('user_42');
    expect(lastBatch()?.sig).toBe('sig-issued-by-the-server');
  });

  it('forgets the user and the signature together on reset', () => {
    window.pa?.('reset');
    window.pa?.('event', 'browse');
    settle();

    expect(lastBatch()?.userId).toBeUndefined();
    expect(lastBatch()?.sig).toBeUndefined();
  });

  it('sends no signature for a site that does not sign, which is the default', () => {
    window.pa?.('identify', 'user_43');
    settle();

    expect(lastBatch()?.userId).toBe('user_43');
    expect(lastBatch()?.sig).toBeUndefined();
  });

  it('drops a stale signature when the next identify comes without one', () => {
    window.pa?.('identify', 'user_44', undefined, 'sig-for-44');
    settle();
    expect(lastBatch()?.sig).toBe('sig-for-44');

    window.pa?.('identify', 'user_45');
    settle();
    expect(lastBatch()?.userId).toBe('user_45');
    expect(lastBatch()?.sig).toBeUndefined();
  });
});
