import { describe, expect, it } from 'vitest';

import { createApiKey, hashApiKey, mintApiKey } from './keys.service.js';
import { createMemoryStore } from '../store/memory.store.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

describe('mintApiKey', () => {
  const minted = mintApiKey({
    siteId: 's_one',
    name: 'reader',
    scopes: ['read:stats'],
    createdBy: 'u_1',
    now: NOW,
  });

  it('answers a prefixed token and a record that holds only its hash', () => {
    expect(minted.token.startsWith('chk_')).toBe(true);
    expect(minted.record.keyHash).toBe(hashApiKey(minted.token));
    expect(minted.record.keyHash).not.toContain(minted.token.slice(4));
  });

  // 256 bits from the system random source: nothing to guess, which is why one
  // round of SHA-256 is the right hash and argon2 would be the wrong one.
  it('is long enough that there is nothing to guess', () => {
    // 32 bytes as base64url is 43 characters, plus the prefix.
    expect(minted.token.length).toBeGreaterThanOrEqual(47);
  });

  it('is different every time', () => {
    const again = mintApiKey({
      siteId: 's_one',
      name: 'reader',
      scopes: ['read:stats'],
      createdBy: 'u_1',
      now: NOW,
    });
    expect(again.token).not.toBe(minted.token);
    expect(again.record.id).not.toBe(minted.record.id);
  });
});

describe('createApiKey', () => {
  it('stores the record and leaves the token with the caller', async () => {
    const store = createMemoryStore([], { now: () => NOW });
    const minted = await createApiKey(store, {
      siteId: 's_one',
      name: 'reader',
      scopes: ['read:stats', 'write:events'],
      createdBy: 'u_1',
      now: NOW,
    });

    const found = await store.apiKeyByHash(hashApiKey(minted.token));
    expect(found?.id).toBe(minted.record.id);
    expect(found?.scopes).toEqual(['read:stats', 'write:events']);
    // The listing never carries a hash, so a list of keys is not a list of things
    // to attack offline.
    const listed = await store.apiKeys('s_one');
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('keyHash');
  });
});
