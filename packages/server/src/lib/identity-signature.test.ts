import { describe, expect, it } from 'vitest';

import { signUserId, verifyUserId } from './identity-signature.js';

// A placeholder, never a real key: no secret belongs in this repository.
const SECRET = 'test-secret-not-a-real-key';

// The shared identify signature test vector.
//
// @chokh/sdk-node makes these signatures and this package verifies them, and the
// two implementations are deliberately separate: a product must not depend on its
// own client SDK. What stops them drifting is this vector, asserted here and again
// in packages/sdk-node/src/index.test.ts with the same three inputs and the same
// expected string. Change the formula on one side and one of the two suites goes
// red.
const VECTOR = {
  identifySecret: 'chokh-identify-test-vector-secret',
  siteId: 'ps_web',
  userId: 'u_42',
  signature: 'PZKnTzQ2RNvGrAh-ROhA2pmOsHB0CiwrBXfINflfMms',
} as const;

describe('the shared test vector', () => {
  it('is what this package issues', () => {
    expect(signUserId(VECTOR.identifySecret, VECTOR.siteId, VECTOR.userId)).toBe(VECTOR.signature);
  });

  it('is what this package accepts, so sdk-node and the collector agree', () => {
    expect(
      verifyUserId(VECTOR.identifySecret, VECTOR.siteId, VECTOR.userId, VECTOR.signature),
    ).toBe(true);
  });
});

describe('the identify signature', () => {
  it('accepts what it issued', () => {
    const sig = signUserId(SECRET, 'site_1', 'u_rafi');
    expect(verifyUserId(SECRET, 'site_1', 'u_rafi', sig)).toBe(true);
  });

  it('is the same every time, so a server can hand the page one and forget it', () => {
    expect(signUserId(SECRET, 'site_1', 'u_rafi')).toBe(signUserId(SECRET, 'site_1', 'u_rafi'));
  });

  it('will not let one user id borrow another signature', () => {
    const sig = signUserId(SECRET, 'site_1', 'u_rafi');
    expect(verifyUserId(SECRET, 'site_1', 'u_mim', sig)).toBe(false);
  });

  it('will not let one site replay another signature', () => {
    // Two installs sharing a secret by accident should still not share
    // identities, which is why the site is in the signed string.
    const sig = signUserId(SECRET, 'site_1', 'u_rafi');
    expect(verifyUserId(SECRET, 'site_2', 'u_rafi', sig)).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    const sig = signUserId('another-placeholder', 'site_1', 'u_rafi');
    expect(verifyUserId(SECRET, 'site_1', 'u_rafi', sig)).toBe(false);
  });

  it('refuses everything when the site has no secret to check against', () => {
    const sig = signUserId(SECRET, 'site_1', 'u_rafi');
    expect(verifyUserId(undefined, 'site_1', 'u_rafi', sig)).toBe(false);
    expect(verifyUserId('', 'site_1', 'u_rafi', sig)).toBe(false);
  });

  it('refuses an empty signature rather than treating it as absent', () => {
    expect(verifyUserId(SECRET, 'site_1', 'u_rafi', '')).toBe(false);
  });

  it('does not throw on a signature of the wrong length', () => {
    expect(verifyUserId(SECRET, 'site_1', 'u_rafi', 'short')).toBe(false);
  });
});
