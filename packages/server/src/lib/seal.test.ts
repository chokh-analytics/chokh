import { describe, expect, it } from 'vitest';

import { createSealer } from './seal.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const SECRET = 'a-test-secret-that-is-not-a-real-one';
const TEN_MINUTES = 10 * 60 * 1000;

describe('a sealed value', () => {
  const sealer = createSealer(SECRET, 'a flow');
  const value = { state: 'st', nonce: 'no', verifier: 'a-verifier-nobody-else-should-read' };

  it('opens as what was sealed, and travels in a cookie as it is', () => {
    const text = sealer.seal(value, TEN_MINUTES, NOW);
    expect(sealer.open(text, NOW + 1000)).toEqual(value);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('cannot be read by whoever carries it', () => {
    const text = sealer.seal(value, TEN_MINUTES, NOW);
    const carried = Buffer.from(text, 'base64url').toString('latin1');
    expect(carried).not.toContain('a-verifier-nobody-else-should-read');
    expect(carried).not.toContain('verifier');
    // And two seals of one value are not the same text.
    expect(sealer.seal(value, TEN_MINUTES, NOW)).not.toBe(text);
  });

  it('opens as nothing once it has run out, to the millisecond', () => {
    const text = sealer.seal(value, TEN_MINUTES, NOW);
    expect(sealer.open(text, NOW + TEN_MINUTES - 1)).toEqual(value);
    expect(sealer.open(text, NOW + TEN_MINUTES)).toBeNull();
  });

  it('opens as nothing when any of it was changed', () => {
    const text = sealer.seal(value, TEN_MINUTES, NOW);
    const raw = Buffer.from(text, 'base64url');
    for (const at of [0, 12, 20, raw.length - 1]) {
      const changed = Buffer.from(raw);
      changed[at] = (changed[at] ?? 0) ^ 1;
      expect(sealer.open(changed.toString('base64url'), NOW)).toBeNull();
    }
    expect(sealer.open(text.slice(0, -4), NOW)).toBeNull();
    expect(sealer.open('', NOW)).toBeNull();
    expect(sealer.open(undefined, NOW)).toBeNull();
    expect(sealer.open('not sealed at all', NOW)).toBeNull();
  });

  it('opens as nothing for another purpose, or under another secret', () => {
    const text = sealer.seal(value, TEN_MINUTES, NOW);
    expect(createSealer(SECRET, 'another flow').open(text, NOW)).toBeNull();
    expect(createSealer('another-secret', 'a flow').open(text, NOW)).toBeNull();
  });
});
