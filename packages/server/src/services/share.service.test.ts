import { describe, expect, it } from 'vitest';

import { createShareCodec, newShareToken, publicShare, SHARE_TTL_MS } from './share.service.js';

// The share cookie (AN-RPT01): signed over the token and over the password's
// hash, so a new link and a new password each end every reader at once.

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const share = { token: 'tok_one', passwordHash: 'argon-one', createdBy: 'u_1', createdAt: NOW };

describe('newShareToken', () => {
  it('is 32 characters of base64url, and never the same twice', () => {
    const one = newShareToken();
    expect(one).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newShareToken()).not.toBe(one);
  });
});

describe('publicShare', () => {
  it('says whether a password stands in the way and never what it is', () => {
    expect(publicShare(share)).toEqual({ token: 'tok_one', protected: true, createdAt: NOW });
    const { passwordHash: _hash, ...open } = share;
    expect(publicShare(open)).toEqual({ token: 'tok_one', protected: false, createdAt: NOW });
  });
});

describe('the share codec', () => {
  const codec = createShareCodec('a-secret-for-the-test');

  it('reads what it issued, for that share, until it expires', () => {
    const issued = codec.issue(share, NOW);
    expect(issued.expiresAt).toBe(NOW + SHARE_TTL_MS);
    expect(codec.read(issued.value, share, NOW)).toBe(true);
    expect(codec.read(issued.value, share, NOW + SHARE_TTL_MS - 1)).toBe(true);
    expect(codec.read(issued.value, share, NOW + SHARE_TTL_MS)).toBe(false);
  });

  it('refuses a cookie for another link, for a changed password, altered, or from another secret', () => {
    const issued = codec.issue(share, NOW).value;
    expect(codec.read(issued, { ...share, token: 'tok_two' }, NOW)).toBe(false);
    expect(codec.read(issued, { ...share, passwordHash: 'argon-two' }, NOW)).toBe(false);
    expect(codec.read(`${issued}x`, share, NOW)).toBe(false);
    expect(codec.read(`x${issued}`, share, NOW)).toBe(false);
    expect(codec.read(createShareCodec('another-secret').issue(share, NOW).value, share, NOW)).toBe(false);
    expect(codec.read(undefined, share, NOW)).toBe(false);
    expect(codec.read('', share, NOW)).toBe(false);
    expect(codec.read('nodot', share, NOW)).toBe(false);
  });

  it('opens a share that took its password off, since there is nothing to match', () => {
    const { passwordHash: _hash, ...open } = share;
    const issued = codec.issue(open, NOW).value;
    expect(codec.read(issued, open, NOW)).toBe(true);
    expect(codec.read(issued, share, NOW)).toBe(false);
  });
});
