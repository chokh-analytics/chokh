import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueue, send } from './queue';
import type { Batch, Config, TrackedEvent } from './types';

const baseConfig: Config = {
  siteId: 'site_1',
  collectUrl: '/_pa/collect',
  hashRouting: false,
  persistentVisitor: true,
  honourDnt: false,
  requireConsent: false,
};

function event(type: TrackedEvent['type'], path = '/'): TrackedEvent {
  return { type, ts: 1, path };
}

function fetchSpy() {
  return vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status: 202 })),
  );
}

// The batch assertions go through the fetch fallback, which carries the body as
// the string the queue built. The beacon path is asserted on its own below.
function queueWith(overrides: Partial<Config> = {}, visitorId?: string) {
  const fetchMock = fetchSpy();
  Object.defineProperty(window, 'fetch', { value: fetchMock, configurable: true });
  Object.defineProperty(window.navigator, 'sendBeacon', { value: undefined, configurable: true });

  const queue = createQueue({
    config: { ...baseConfig, ...overrides },
    win: window,
    context: () => (visitorId === undefined ? {} : { visitorId }),
    page: () => ({ hostname: 'example.test', lang: 'en', screen: '2x1', viewport: '1x1' }),
  });

  const sent = (): Batch[] =>
    fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as Batch);

  return { queue, sent, fetchMock };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('batching', () => {
  it('holds events and sends them as one batch after the flush delay', () => {
    const { queue, sent } = queueWith({}, 'v1');

    queue.push(event('pageview'));
    queue.push(event('heartbeat'));
    expect(sent()).toHaveLength(0);
    expect(queue.pending()).toBe(2);

    vi.advanceTimersByTime(1000);

    const batches = sent();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.events).toHaveLength(2);
    expect(batches[0]?.siteId).toBe('site_1');
    expect(batches[0]?.visitorId).toBe('v1');
    expect(batches[0]?.hostname).toBe('example.test');
    expect(batches[0]?.screen).toBe('2x1');
    expect(batches[0]?.lang).toBe('en');
  });

  it('sends immediately once the batch is full, without waiting for the timer', () => {
    const { queue, sent } = queueWith();

    for (let i = 0; i < 20; i++) {
      queue.push(event('event'));
    }

    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.events).toHaveLength(20);
    expect(queue.pending()).toBe(0);
  });

  it('sends nothing when there is nothing to send', () => {
    const { queue, sent } = queueWith();
    queue.flush();
    expect(sent()).toHaveLength(0);
  });

  it('leaves the visitor id out when the site is cookieless', () => {
    const { queue, sent } = queueWith({ persistentVisitor: false });
    queue.push(event('pageview'));
    queue.flush();
    expect(sent()[0]).not.toHaveProperty('visitorId');
  });

  it('does not start a second timer while one is already pending', () => {
    const { queue, sent } = queueWith();
    queue.push(event('pageview'));
    vi.advanceTimersByTime(600);
    queue.push(event('event'));
    vi.advanceTimersByTime(600);

    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.events).toHaveLength(2);
  });
});

describe('consent', () => {
  it('holds everything back until consent is given, then sends it', () => {
    const { queue, sent } = queueWith({ requireConsent: true });

    queue.push(event('pageview'));
    vi.advanceTimersByTime(5000);
    expect(sent()).toHaveLength(0);

    queue.allow(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.events).toHaveLength(1);
  });

  it('drops what it held when consent is refused', () => {
    const { queue, sent } = queueWith({ requireConsent: true });

    queue.push(event('pageview'));
    queue.allow(false);
    expect(queue.pending()).toBe(0);

    queue.allow(true);
    expect(sent()).toHaveLength(0);
  });
});

describe('transport', () => {
  it('prefers sendBeacon and sends the batch as a blob', () => {
    const beacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
    const fetchMock = fetchSpy();
    Object.defineProperty(window.navigator, 'sendBeacon', { value: beacon, configurable: true });
    Object.defineProperty(window, 'fetch', { value: fetchMock, configurable: true });

    send(window, '/_pa/collect', '{"a":1}');

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0]?.[0]).toBe('/_pa/collect');
    expect(beacon.mock.calls[0]?.[1]).toBeInstanceOf(Blob);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a keepalive fetch when the beacon is refused', () => {
    const fetchMock = fetchSpy();
    Object.defineProperty(window, 'fetch', { value: fetchMock, configurable: true });
    Object.defineProperty(window.navigator, 'sendBeacon', {
      value: () => false,
      configurable: true,
    });

    send(window, '/_pa/collect', '{"a":1}');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.keepalive).toBe(true);
    expect(init?.body).toBe('{"a":1}');
  });

  it('falls back when sendBeacon is missing entirely', () => {
    const fetchMock = fetchSpy();
    Object.defineProperty(window, 'fetch', { value: fetchMock, configurable: true });
    Object.defineProperty(window.navigator, 'sendBeacon', { value: undefined, configurable: true });

    send(window, '/_pa/collect', '{"a":1}');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
