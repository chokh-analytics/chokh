import { describe, expect, it } from 'vitest';

import { applyIpMode } from './ip-privacy.js';

describe('applyIpMode', () => {
  it('stores the address as it arrived in full mode', () => {
    expect(applyIpMode('103.87.12.45', 'full')).toBe('103.87.12.45');
    expect(applyIpMode('2001:db8:85a3:8d3:1319:8a2e:370:7348', 'full')).toBe(
      '2001:db8:85a3:8d3:1319:8a2e:370:7348',
    );
  });

  it('zeroes the last octet in anonymized mode', () => {
    expect(applyIpMode('103.87.12.45', 'anonymized')).toBe('103.87.12.0');
    expect(applyIpMode('8.8.8.8', 'anonymized')).toBe('8.8.8.0');
  });

  it('cuts an IPv6 address at the same place', () => {
    expect(applyIpMode('2001:db8:85a3:8d3:1319:8a2e:370:7348', 'anonymized')).toBe(
      '2001:db8:85a3:8d3::',
    );
  });

  it('reads an IPv4 address that arrived mapped into IPv6', () => {
    expect(applyIpMode('::ffff:103.87.12.45', 'anonymized')).toBe('103.87.12.0');
  });

  it('stores nothing at all in none mode', () => {
    expect(applyIpMode('103.87.12.45', 'none')).toBeUndefined();
    expect(applyIpMode('2001:db8::1', 'none')).toBeUndefined();
  });

  it('stores nothing for an address it cannot parse', () => {
    expect(applyIpMode('not-an-address', 'anonymized')).toBeUndefined();
  });
});
