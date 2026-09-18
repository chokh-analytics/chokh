import { describe, expect, it } from 'vitest';

import {
  FORWARDED_MAX_AGE_MS,
  signForwardedAddress,
  verifyForwardedAddress,
} from './forwarded-address.js';

// A placeholder, never a real key: no secret belongs in this repository.
const SECRET = 'test-proxy-secret-not-a-real-key-0000';
const IP = '103.87.12.45';
const NOW = 1758268800000;

// The shared forwarded address test vector.
//
// A first-party proxy makes these signatures through @chokh/sdk-node and this
// package verifies them, and the two implementations are deliberately separate: a
// product must not depend on its own client SDK. What stops them drifting is this
// vector, asserted here and again in packages/sdk-node/src/index.test.ts with the
// same three inputs and the same expected string. Change the formula on one side
// and one of the two suites goes red.
const VECTOR = {
  proxySecret: 'chokh-forwarded-test-vector-secret',
  ip: '103.87.12.45',
  ts: 1758268800000,
  signature: 'vxccd7YCjDD2KrAqUmGDrfSTHL5jlRlHITsOsLZqlho',
} as const;

function header(secret: string, ip: string, ts: number): string {
  return `${ts}.${signForwardedAddress(secret, ip, ts)}`;
}

describe('the shared test vector', () => {
  it('is what this package issues', () => {
    expect(signForwardedAddress(VECTOR.proxySecret, VECTOR.ip, VECTOR.ts)).toBe(VECTOR.signature);
  });

  it('is what this package accepts, so sdk-node and the collector agree', () => {
    expect(
      verifyForwardedAddress(
        VECTOR.proxySecret,
        VECTOR.ip,
        `${VECTOR.ts}.${VECTOR.signature}`,
        VECTOR.ts,
      ),
    ).toBe(true);
  });
});

describe('the forwarded address signature', () => {
  it('accepts what a proxy holding the secret issued', () => {
    expect(verifyForwardedAddress(SECRET, IP, header(SECRET, IP, NOW), NOW)).toBe(true);
  });

  it('binds the signature to the address, so one cannot be reused for another', () => {
    expect(verifyForwardedAddress(SECRET, '198.51.100.7', header(SECRET, IP, NOW), NOW)).toBe(
      false,
    );
  });

  it('refuses a signature made with another secret', () => {
    expect(
      verifyForwardedAddress(SECRET, IP, header('another-placeholder-entirely', IP, NOW), NOW),
    ).toBe(false);
  });

  it('refuses a ts that was not the one signed', () => {
    const sig = signForwardedAddress(SECRET, IP, NOW);
    expect(verifyForwardedAddress(SECRET, IP, `${NOW - 1}.${sig}`, NOW)).toBe(false);
  });

  it('refuses a signature older than the window, however well it was made', () => {
    const stale = NOW - FORWARDED_MAX_AGE_MS - 1;
    expect(verifyForwardedAddress(SECRET, IP, header(SECRET, IP, stale), NOW)).toBe(false);
    expect(verifyForwardedAddress(SECRET, IP, header(SECRET, IP, NOW - 1000), NOW)).toBe(true);
  });

  // A proxy whose clock is a little ahead is as ordinary as one a little behind.
  it('refuses a signature further ahead than the window and allows one just inside it', () => {
    expect(
      verifyForwardedAddress(SECRET, IP, header(SECRET, IP, NOW + FORWARDED_MAX_AGE_MS + 1), NOW),
    ).toBe(false);
    expect(verifyForwardedAddress(SECRET, IP, header(SECRET, IP, NOW + 1000), NOW)).toBe(true);
  });

  it('refuses a header that carries no ts, or no signature, or neither', () => {
    expect(verifyForwardedAddress(SECRET, IP, signForwardedAddress(SECRET, IP, NOW), NOW)).toBe(
      false,
    );
    expect(verifyForwardedAddress(SECRET, IP, `${NOW}.`, NOW)).toBe(false);
    expect(verifyForwardedAddress(SECRET, IP, '', NOW)).toBe(false);
  });

  // A ts of "0123" would be signed here as "123", so one address would have two
  // header values that pass.
  it('refuses a ts that is not written in the one way', () => {
    const sig = signForwardedAddress(SECRET, IP, NOW);
    expect(verifyForwardedAddress(SECRET, IP, `0${NOW}.${sig}`, NOW)).toBe(false);
    expect(verifyForwardedAddress(SECRET, IP, `${NOW}.0.${sig}`, NOW)).toBe(false);
    expect(verifyForwardedAddress(SECRET, IP, `not-a-number.${sig}`, NOW)).toBe(false);
  });

  it('believes nobody when the install has no secret, or the address is empty', () => {
    expect(verifyForwardedAddress(undefined, IP, header(SECRET, IP, NOW), NOW)).toBe(false);
    expect(verifyForwardedAddress('', IP, header(SECRET, IP, NOW), NOW)).toBe(false);
    expect(verifyForwardedAddress(SECRET, '', header(SECRET, '', NOW), NOW)).toBe(false);
  });
});
