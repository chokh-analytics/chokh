import { describe, expect, it } from 'vitest';

import { createWindowCounter } from './window-counter.js';

describe('createWindowCounter', () => {
  it('counts hits on a key inside the window', () => {
    const counter = createWindowCounter(60_000);
    expect(counter.hit('a', 1000)).toBe(1);
    expect(counter.hit('a', 2000)).toBe(2);
    expect(counter.hit('a', 3000)).toBe(3);
  });

  it('counts keys apart', () => {
    const counter = createWindowCounter(60_000);
    counter.hit('a', 1000);
    expect(counter.hit('b', 1000)).toBe(1);
  });

  it('adds more than one at a time', () => {
    const counter = createWindowCounter(60_000);
    expect(counter.hit('a', 1000, 5)).toBe(5);
    expect(counter.hit('a', 1000, 3)).toBe(8);
  });

  it('starts again when the window rolls, so memory stays bounded', () => {
    const counter = createWindowCounter(60_000);
    counter.hit('a', 1000);
    counter.hit('a', 2000);
    expect(counter.hit('a', 62_000)).toBe(1);
  });
});
