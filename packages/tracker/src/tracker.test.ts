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
