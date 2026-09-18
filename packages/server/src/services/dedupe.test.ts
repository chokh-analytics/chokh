import { describe, expect, it } from 'vitest';

import { DEDUPE_WINDOW_MS, createDedupe } from './dedupe.js';

describe('createDedupe', () => {
  it('sees a key the first time and calls the next one within the window a repeat', () => {
    const dedupe = createDedupe();
    expect(dedupe.seen('a', 1000)).toBe(false);
    expect(dedupe.seen('a', 1000 + DEDUPE_WINDOW_MS - 1)).toBe(true);
  });

  it('lets the same key through once the window has passed', () => {
    const dedupe = createDedupe();
    expect(dedupe.seen('a', 1000)).toBe(false);
    expect(dedupe.seen('a', 1000 + DEDUPE_WINDOW_MS)).toBe(false);
  });

  it('keeps different keys apart', () => {
    const dedupe = createDedupe();
    expect(dedupe.seen('a', 1000)).toBe(false);
    expect(dedupe.seen('b', 1000)).toBe(false);
  });
});
