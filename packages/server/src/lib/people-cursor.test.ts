import { describe, expect, it } from 'vitest';

import { decodePeopleCursor, encodePeopleCursor } from './people-cursor.js';

describe('the people cursor', () => {
  it('reads back what it wrote, an id of any characters included', () => {
    for (const cursor of [
      { lastSeenAt: Date.UTC(2026, 10, 11, 9, 0, 0), visitorId: 'v_1' },
      { lastSeenAt: 0, visitorId: 'a/b?c=d&e f' },
      { lastSeenAt: 1, visitorId: 'রফি' },
    ]) {
      const text = encodePeopleCursor(cursor);
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodePeopleCursor(text)).toEqual(cursor);
    }
  });

  it('refuses anything it did not write', () => {
    const forged = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    expect(decodePeopleCursor('not a cursor')).toBeNull();
    expect(decodePeopleCursor('')).toBeNull();
    expect(decodePeopleCursor(forged({ lastSeenAt: 1, visitorId: 'v' }))).toBeNull();
    expect(decodePeopleCursor(forged([-1, 'v']))).toBeNull();
    expect(decodePeopleCursor(forged([1.5, 'v']))).toBeNull();
    expect(decodePeopleCursor(forged([1, '']))).toBeNull();
    expect(decodePeopleCursor(forged([1, 'v', 'extra']))).toBeNull();
  });
});
