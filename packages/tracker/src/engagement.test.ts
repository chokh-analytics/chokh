import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_MS, createEngagement, scrollQuartile } from './engagement';

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function setScroll(scrollHeight: number, scrollY: number, innerHeight: number): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(document.body, 'scrollHeight', { value: 0, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scrollQuartile', () => {
  it('reports the quartile the deepest pixel seen falls into', () => {
    setScroll(1000, 0, 200);
    expect(scrollQuartile(window, document)).toBe(0);

    setScroll(1000, 100, 200);
    expect(scrollQuartile(window, document)).toBe(25);

    setScroll(1000, 400, 200);
    expect(scrollQuartile(window, document)).toBe(50);

    setScroll(1000, 600, 200);
    expect(scrollQuartile(window, document)).toBe(75);

    setScroll(1000, 800, 200);
    expect(scrollQuartile(window, document)).toBe(100);
  });

  it('is zero for a page with no measurable height', () => {
    setScroll(0, 0, 200);
    expect(scrollQuartile(window, document)).toBe(0);
  });
});

describe('heartbeat', () => {
  it('beats every 20 seconds while the tab is visible', () => {
    const beat = vi.fn();
    createEngagement(window, document, beat).start();

    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it('stops while the tab is hidden and beats at once when it comes back', () => {
    const beat = vi.fn();
    createEngagement(window, document, beat).start();

    setVisibility('hidden');
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(beat).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(beat).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(beat).toHaveBeenCalledTimes(2);
  });
});

describe('time on page', () => {
  it('counts only the time the tab was visible', () => {
    const engagement = createEngagement(window, document, () => undefined);
    engagement.start();

    vi.advanceTimersByTime(5000);
    setVisibility('hidden');
    vi.advanceTimersByTime(60000);
    setVisibility('visible');
    vi.advanceTimersByTime(3000);

    expect(engagement.duration()).toBe(8000);
  });

  it('starts again from zero on the next pageview', () => {
    const engagement = createEngagement(window, document, () => undefined);
    engagement.start();

    vi.advanceTimersByTime(5000);
    engagement.reset();
    vi.advanceTimersByTime(2000);

    expect(engagement.duration()).toBe(2000);
  });
});

describe('scroll depth', () => {
  it('keeps the deepest quartile reached, not the last one', () => {
    setScroll(1000, 0, 200);
    const engagement = createEngagement(window, document, () => undefined);
    engagement.start();

    setScroll(1000, 600, 200);
    window.dispatchEvent(new Event('scroll'));
    expect(engagement.scrollDepth()).toBe(75);

    setScroll(1000, 0, 200);
    window.dispatchEvent(new Event('scroll'));
    expect(engagement.scrollDepth()).toBe(75);
  });

  it('starts again from zero on the next pageview', () => {
    setScroll(1000, 600, 200);
    const engagement = createEngagement(window, document, () => undefined);
    engagement.start();
    expect(engagement.scrollDepth()).toBe(75);

    setScroll(1000, 0, 200);
    engagement.reset();
    expect(engagement.scrollDepth()).toBe(0);
  });
});
