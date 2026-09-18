import { beforeEach, describe, expect, it } from 'vitest';

import { clearVisitorId, readVisitorId, safeStorage } from './visitor';

beforeEach(() => {
  window.localStorage.clear();
});

describe('readVisitorId', () => {
  it('stores nothing and returns nothing when the site is cookieless', () => {
    expect(readVisitorId(null, 's1')).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
  });

  it('mints an id once and returns the same one afterwards', () => {
    const store = safeStorage(window);
    const first = readVisitorId(store, 's1');
    expect(first).toBeTruthy();
    expect(readVisitorId(store, 's1')).toBe(first);
  });

  it('keeps one id per site', () => {
    const store = safeStorage(window);
    expect(readVisitorId(store, 's1')).not.toBe(readVisitorId(store, 's2'));
  });

  it('mints a new id once the old one is older than 13 months', () => {
    const store = safeStorage(window);
    const first = readVisitorId(store, 's1');
    const longAgo = Date.now() - 14 * 30 * 24 * 60 * 60 * 1000;
    window.localStorage.setItem('chokh.s1', 'old-id.' + longAgo);

    const second = readVisitorId(store, 's1');
    expect(second).not.toBe('old-id');
    expect(second).not.toBe(first);
  });
});

describe('clearVisitorId', () => {
  it('forgets the visitor so reset starts a new one', () => {
    const store = safeStorage(window);
    const first = readVisitorId(store, 's1');
    clearVisitorId(store, 's1');
    expect(window.localStorage.getItem('chokh.s1')).toBeNull();
    expect(readVisitorId(store, 's1')).not.toBe(first);
  });

  it('does nothing when there is no store', () => {
    expect(() => clearVisitorId(null, 's1')).not.toThrow();
  });
});
