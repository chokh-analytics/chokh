import { afterEach, describe, expect, it, vi } from 'vitest';

import { readChoice, themeStorage, writeChoice } from './theme.js';

// A browser that blocks a site's data throws on the read of `localStorage`
// itself, before any method is called. The dashboard has to draw anyway,
// with the theme the system says, and a choice is then simply not kept.
describe('the theme in a browser that refuses storage', () => {
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage');

  afterEach(() => {
    if (real !== undefined) {
      Object.defineProperty(window, 'localStorage', real);
    }
    vi.restoreAllMocks();
  });

  it('gives no storage instead of throwing, and the choice is the system', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('refused', 'SecurityError');
      },
    });
    expect(() => themeStorage()).not.toThrow();
    expect(themeStorage()).toBeUndefined();
    expect(readChoice(themeStorage())).toBe('system');
    expect(() => writeChoice(themeStorage(), 'dark')).not.toThrow();
  });

  it('gives the storage when the browser allows it', () => {
    expect(themeStorage()).toBe(window.localStorage);
  });
});
