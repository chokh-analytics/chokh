import { describe, expect, it } from 'vitest';

import { envSchema } from './env.js';

// A compose file writing GEOIP_LICENSE_KEY: ${GEOIP_LICENSE_KEY:-} hands over an
// empty string, and an empty string has to mean unset or the server refuses to
// start for a variable nobody was asked to set.
describe('envSchema', () => {
  it('reads an empty optional variable as unset', () => {
    const parsed = envSchema.parse({
      GEOIP_LICENSE_KEY: '',
      MONGODB_URI: '',
      REDIS_URL: '',
      DASHBOARD_DIR: '',
    });

    expect(parsed.GEOIP_LICENSE_KEY).toBeUndefined();
    expect(parsed.MONGODB_URI).toBeUndefined();
    expect(parsed.REDIS_URL).toBeUndefined();
    expect(parsed.DASHBOARD_DIR).toBeUndefined();
  });

  it('falls back to the default when a variable with one arrives empty', () => {
    const parsed = envSchema.parse({ GEOIP_DIR: '', REAL_IP_HEADER: '', TRUST_PROXY: '' });

    expect(parsed.GEOIP_DIR).toBe('./data/geo');
    expect(parsed.REAL_IP_HEADER).toBe('x-forwarded-for');
    expect(parsed.TRUST_PROXY).toEqual([]);
  });

  it('keeps a value that was actually set', () => {
    const parsed = envSchema.parse({
      GEOIP_LICENSE_KEY: 'a-key',
      GEOIP_DIR: '/var/lib/chokh/geo',
      PORT: '4200',
    });

    expect(parsed.GEOIP_LICENSE_KEY).toBe('a-key');
    expect(parsed.GEOIP_DIR).toBe('/var/lib/chokh/geo');
    expect(parsed.PORT).toBe(4200);
  });

  it('reads the trusted proxies as a list, ignoring spacing and empty entries', () => {
    const parsed = envSchema.parse({ TRUST_PROXY: '173.245.48.0/20, 172.30.0.1/32 ,' });

    expect(parsed.TRUST_PROXY).toEqual(['173.245.48.0/20', '172.30.0.1/32']);
  });

  it('holds a campus behind one address by default', () => {
    const parsed = envSchema.parse({});

    // A tab posts three batches a minute, so the default has to carry about a
    // thousand open tabs on one NAT address.
    expect(parsed.COLLECT_RATE_LIMIT_IP).toBe(3000);
    expect(parsed.COLLECT_RATE_LIMIT_SITE).toBe(60000);
  });

  it('takes a rate limit the operator set instead', () => {
    expect(envSchema.parse({ COLLECT_RATE_LIMIT_IP: '120' }).COLLECT_RATE_LIMIT_IP).toBe(120);
  });

  it('refuses a rate limit that would refuse everything', () => {
    expect(() => envSchema.parse({ COLLECT_RATE_LIMIT_IP: '0' })).toThrow();
    expect(() => envSchema.parse({ COLLECT_RATE_LIMIT_IP: '-1' })).toThrow();
  });

  it('reads the real IP header whatever case it was written in', () => {
    expect(envSchema.parse({ REAL_IP_HEADER: 'CF-Connecting-IP' }).REAL_IP_HEADER).toBe(
      'cf-connecting-ip',
    );
  });

  it('refuses a real IP header the collector does not know how to trust', () => {
    expect(() => envSchema.parse({ REAL_IP_HEADER: 'X-Real-IP' })).toThrow();
  });
});
