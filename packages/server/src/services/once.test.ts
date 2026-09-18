import { describe, expect, it } from 'vitest';

import { createMemoryOnce } from './once.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

describe('the in-process single-use set', () => {
  it('lets a key through once and refuses it after', async () => {
    const once = createMemoryOnce(() => NOW);
    expect(await once.claim('sso:abc', 300_000)).toBe(true);
    expect(await once.claim('sso:abc', 300_000)).toBe(false);
    expect(await once.claim('sso:abc', 300_000)).toBe(false);
  });

  it('keeps different keys apart', async () => {
    const once = createMemoryOnce(() => NOW);
    expect(await once.claim('sso:abc', 300_000)).toBe(true);
    expect(await once.claim('sso:def', 300_000)).toBe(true);
  });

  // The claim only has to outlive the token. Afterwards the token is refused on its
  // own expiry, so holding the claim for longer would only be memory.
  it('forgets a key once its window has closed', async () => {
    let at = NOW;
    const once = createMemoryOnce(() => at);
    expect(await once.claim('sso:abc', 1000)).toBe(true);
    at = NOW + 999;
    expect(await once.claim('sso:abc', 1000)).toBe(false);
    at = NOW + 1001;
    expect(await once.claim('sso:abc', 1000)).toBe(true);
  });
});
