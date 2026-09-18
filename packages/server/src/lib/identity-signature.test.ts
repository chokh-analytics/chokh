import { describe, expect, it } from 'vitest';

import { signUserId, verifyUserId } from './identity-signature.js';

// A placeholder, never a real key: no secret belongs in this repository.
const SECRET = 'test-secret-not-a-real-key';

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
