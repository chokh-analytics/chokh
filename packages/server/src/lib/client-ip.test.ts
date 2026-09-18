import { describe, expect, it } from 'vitest';

import { clientIp, isTrustedProxy } from './client-ip.js';
import { signForwardedAddress } from './forwarded-address.js';

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

describe('clientIp in the signed forwarded mode', () => {
  // A placeholder, never a real key.
  const SECRET = 'test-proxy-secret-not-a-real-key-0000';
  const NOW = 1758268800000;
  const options = {
    trustProxy: CLOUDFLARE,
    realIpHeader: 'x-chokh-forwarded-for',
    proxySecret: SECRET,
  };

  function forwarded(ip: string, ts: number, secret = SECRET) {
    return {
      // The peer chain, which is the proxy's own address and what everybody
      // would otherwise be stored as.
      ip: '198.51.100.7',
      peer: '203.0.113.9',
      header: ip,
      signature: `${ts}.${signForwardedAddress(secret, ip, ts)}`,
      now: NOW,
    };
  }

  it('believes the forwarded address when the proxy signed it', () => {
    expect(clientIp(forwarded('103.87.12.45', NOW), options)).toBe('103.87.12.45');
  });

  // The signature is the trust here, not a peer range: the proxy is somebody
  // else's infrastructure with an address range that changes without notice.
  it('does not ask whether the peer is a trusted proxy', () => {
    expect(clientIp(forwarded('103.87.12.45', NOW), { ...options, trustProxy: [] })).toBe(
      '103.87.12.45',
    );
  });

  it('falls back to the peer chain on a forged signature, rather than refusing', () => {
    const source = { ...forwarded('103.87.12.45', NOW), signature: `${NOW}.forged` };
    expect(clientIp(source, options)).toBe('198.51.100.7');
  });

  it('falls back when the signature was made with another secret', () => {
    expect(clientIp(forwarded('103.87.12.45', NOW, 'a-different-placeholder'), options)).toBe(
      '198.51.100.7',
    );
  });

  it('falls back on a ts outside the window, so a header out of a log is worth nothing', () => {
    expect(clientIp(forwarded('103.87.12.45', NOW - 121_000), options)).toBe('198.51.100.7');
  });

  it('falls back when the pair is absent, which is every request a proxy did not make', () => {
    expect(
      clientIp({ ip: '198.51.100.7', peer: '203.0.113.9', header: undefined }, options),
    ).toBe('198.51.100.7');
    expect(
      clientIp(
        { ip: '198.51.100.7', peer: '203.0.113.9', header: '103.87.12.45', now: NOW },
        options,
      ),
    ).toBe('198.51.100.7');
  });

  it('falls back when the install lost its secret', () => {
    expect(clientIp(forwarded('103.87.12.45', NOW), { ...options, proxySecret: undefined })).toBe(
      '198.51.100.7',
    );
  });
});
