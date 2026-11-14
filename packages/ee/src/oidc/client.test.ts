import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ASYMMETRIC_ALGORITHMS, allowedEndpoint, challengeOf } from './client.js';

// The two small rules of the provider's end that everything else stands on:
// where a secret or a decision about who somebody is may travel, and what a
// PKCE challenge is.

describe('where the provider may be reached', () => {
  it('is over https, anywhere', () => {
    expect(allowedEndpoint('https://id.example.com/token')?.href).toBe('https://id.example.com/token');
  });

  it('is over plain http on this machine only, which is what a test uses', () => {
    for (const here of ['http://127.0.0.1:4000/keys', 'http://localhost:4000/keys', 'http://[::1]:4000/keys']) {
      expect(allowedEndpoint(here)).not.toBeNull();
    }
    for (const elsewhere of [
      'http://id.example.com/token',
      'http://10.0.0.5/token',
      'http://127.0.0.1.example.com/token',
      'http://localhost.example.com/token',
    ]) {
      expect(allowedEndpoint(elsewhere)).toBeNull();
    }
  });

  it('is never anything else', () => {
    for (const other of ['file:///etc/passwd', 'ftp://id.example.com/', 'javascript:alert(1)', 'not a url', '', 7, undefined, null]) {
      expect(allowedEndpoint(other)).toBeNull();
    }
  });
});

describe('what is told to the library', () => {
  it('is a list of asymmetric algorithms, with nothing shared-secret and no "none" in it', () => {
    expect(ASYMMETRIC_ALGORITHMS.some((name) => name.startsWith('HS'))).toBe(false);
    expect((ASYMMETRIC_ALGORITHMS as readonly string[]).includes('none')).toBe(false);
    expect(ASYMMETRIC_ALGORITHMS.length).toBeGreaterThan(5);
  });

  it('is a challenge that is the SHA-256 of the verifier, as S256 says', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    // The example in RFC 7636, appendix B.
    expect(challengeOf(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(challengeOf(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});
