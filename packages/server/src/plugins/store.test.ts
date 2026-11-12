import { describe, expect, it } from 'vitest';

import { createLateLog } from './store.js';

// The store is opened before the app, because the app is built around it, so
// what the store says at boot has nowhere to go yet.
describe('a log that arrives late', () => {
  it('keeps what was said before there was a logger, in order, and says it once', () => {
    const late = createLateLog();
    late.warn({ rows: 2 }, 'first');
    late.warn({ rows: 5 }, 'second');
    const heard: [object, string][] = [];
    late.use({ warn: (details, message) => heard.push([details, message]) });
    expect(heard).toEqual([
      [{ rows: 2 }, 'first'],
      [{ rows: 5 }, 'second'],
    ]);
    late.warn({ rows: 1 }, 'third');
    expect(heard).toHaveLength(3);
    expect(heard[2]).toEqual([{ rows: 1 }, 'third']);
  });
});
