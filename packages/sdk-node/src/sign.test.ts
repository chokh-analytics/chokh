import { describe, expect, it } from 'vitest';

import { signForwardedAddress, signUserId } from './sign.js';

// The shared identify signature test vector.
//
// The collector verifies these signatures and this package makes them, and the two
// implementations are deliberately separate: a product must not depend on its own
// client SDK. What stops them drifting is this vector, asserted here and again in
// packages/server/src/lib/identity-signature.test.ts with the same three inputs and
// the same expected string. Change the formula on one side and one of the two
// suites goes red.
export const VECTOR = {
  identifySecret: 'chokh-identify-test-vector-secret',
  siteId: 'ps_web',
  userId: 'u_42',
  signature: 'PZKnTzQ2RNvGrAh-ROhA2pmOsHB0CiwrBXfINflfMms',
} as const;

// The shared forwarded address test vector.
//
// The collector verifies these signatures and this package makes them, and the two
// implementations are deliberately separate for the same reason as the identify
// pair. What stops them drifting is this vector, asserted here and again in
// packages/server/src/lib/forwarded-address.test.ts with the same three inputs and
// the same expected string.
export const FORWARDED_VECTOR = {
  proxySecret: 'chokh-forwarded-test-vector-secret',
  ip: '103.87.12.45',
  ts: 1758268800000,
  signature: 'vxccd7YCjDD2KrAqUmGDrfSTHL5jlRlHITsOsLZqlho',
} as const;

describe('signUserId', () => {
  it('answers the shared test vector', () => {
    expect(signUserId(VECTOR.identifySecret, VECTOR.siteId, VECTOR.userId)).toBe(VECTOR.signature);
  });

  it('binds the signature to the site, so one cannot be replayed at another', () => {
    expect(signUserId(VECTOR.identifySecret, 'ps_admin', VECTOR.userId)).not.toBe(VECTOR.signature);
  });

  it('changes with the user and with the secret', () => {
    expect(signUserId(VECTOR.identifySecret, VECTOR.siteId, 'u_43')).not.toBe(VECTOR.signature);
    expect(signUserId('another-secret-entirely', VECTOR.siteId, VECTOR.userId)).not.toBe(
      VECTOR.signature,
    );
  });
});

describe('signForwardedAddress', () => {
  it('answers the shared test vector', () => {
    expect(
      signForwardedAddress(FORWARDED_VECTOR.proxySecret, FORWARDED_VECTOR.ip, FORWARDED_VECTOR.ts),
    ).toBe(FORWARDED_VECTOR.signature);
  });

  it('binds the signature to the address, so one cannot be reused for another', () => {
    expect(
      signForwardedAddress(FORWARDED_VECTOR.proxySecret, '198.51.100.7', FORWARDED_VECTOR.ts),
    ).not.toBe(FORWARDED_VECTOR.signature);
  });

  // Without the ts in the signed string a header read out of a log would be an
  // address somebody could claim for as long as they kept the line.
  it('changes with the instant and with the secret', () => {
    expect(
      signForwardedAddress(FORWARDED_VECTOR.proxySecret, FORWARDED_VECTOR.ip, 1758268800001),
    ).not.toBe(FORWARDED_VECTOR.signature);
    expect(
      signForwardedAddress('another-secret-entirely', FORWARDED_VECTOR.ip, FORWARDED_VECTOR.ts),
    ).not.toBe(FORWARDED_VECTOR.signature);
  });
});
