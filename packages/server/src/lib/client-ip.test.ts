import { describe, expect, it } from 'vitest';

import { clientIp, isTrustedProxy } from './client-ip.js';

const CLOUDFLARE = ['173.245.48.0/20', '172.30.0.1/32'];

describe('isTrustedProxy', () => {
  it('trusts a peer inside one of the ranges', () => {
    expect(isTrustedProxy('173.245.48.9', CLOUDFLARE)).toBe(true);
    expect(isTrustedProxy('172.30.0.1', CLOUDFLARE)).toBe(true);
  });

  it('trusts nobody when no range is configured', () => {
    expect(isTrustedProxy('173.245.48.9', [])).toBe(false);
  });

  it('does not trust a peer outside the ranges', () => {
    expect(isTrustedProxy('103.87.12.45', CLOUDFLARE)).toBe(false);
    expect(isTrustedProxy(undefined, CLOUDFLARE)).toBe(false);
  });

  it('reads a peer that arrived as an IPv4 address mapped into IPv6', () => {
    expect(isTrustedProxy('::ffff:172.30.0.1', CLOUDFLARE)).toBe(true);
  });

  it('does not match an IPv6 peer against an IPv4 range', () => {
    expect(isTrustedProxy('2001:db8::1', CLOUDFLARE)).toBe(false);
  });

  it('trusts nobody through a malformed range', () => {
    expect(isTrustedProxy('173.245.48.9', ['not-a-cidr'])).toBe(false);
  });
});

describe('clientIp', () => {
  const source = {
    ip: '198.51.100.7',
    peer: '172.30.0.1',
    header: '103.87.12.45, 172.30.0.1',
  };

  it('takes what Fastify resolved when the header is X-Forwarded-For', () => {
    expect(clientIp(source, { trustProxy: CLOUDFLARE, realIpHeader: 'x-forwarded-for' })).toBe(
      '198.51.100.7',
    );
  });

  it('reads CF-Connecting-IP when the peer is a trusted proxy', () => {
    expect(
      clientIp(
        { ip: '198.51.100.7', peer: '173.245.48.9', header: '103.87.12.45' },
        { trustProxy: CLOUDFLARE, realIpHeader: 'cf-connecting-ip' },
      ),
    ).toBe('103.87.12.45');
  });

  it('ignores the header when the peer is not trusted, so nobody can claim an address', () => {
    expect(
      clientIp(
        { ip: '198.51.100.7', peer: '203.0.113.9', header: '103.87.12.45' },
        { trustProxy: CLOUDFLARE, realIpHeader: 'cf-connecting-ip' },
      ),
    ).toBe('198.51.100.7');
  });

  it('takes the first address when a trusted proxy sent a list', () => {
    expect(clientIp(source, { trustProxy: CLOUDFLARE, realIpHeader: 'cf-connecting-ip' })).toBe(
      '103.87.12.45',
    );
  });

  it('falls back when the trusted proxy sent no header at all', () => {
    expect(
      clientIp(
        { ip: '198.51.100.7', peer: '172.30.0.1', header: undefined },
        { trustProxy: CLOUDFLARE, realIpHeader: 'cf-connecting-ip' },
      ),
    ).toBe('198.51.100.7');
  });
});
