import { describe, expect, it } from 'vitest';

import { compileExclusions, isAddressRule, isPathRule } from './exclusions.js';

// The three lists a site keeps its own traffic out with, compiled the way the
// collector compiles them. What the collector does with an answer is proved
// over HTTP in collect.routes.test.ts; this is the answers themselves.

describe('excluded addresses', () => {
  const excluded = compileExclusions({
    excludeIps: ['103.87.12.9', '10.0.0.0/8', '2001:db8::/32', 'not-an-address'],
    excludePaths: [],
    excludeQueryParams: [],
  });

  it('matches an exact address and a range, in both families', () => {
    expect(excluded.ip('103.87.12.9')).toBe(true);
    expect(excluded.ip('103.87.12.10')).toBe(false);
    expect(excluded.ip('10.200.3.4')).toBe(true);
    expect(excluded.ip('11.0.0.1')).toBe(false);
    expect(excluded.ip('2001:db8:1::1')).toBe(true);
    expect(excluded.ip('2001:db9::1')).toBe(false);
  });

  it('reads an IPv4 address carried inside IPv6 as the IPv4 address it is', () => {
    expect(excluded.ip('::ffff:103.87.12.9')).toBe(true);
  });

  it('excludes nobody for no address, a bad address or a bad rule', () => {
    expect(excluded.ip(undefined)).toBe(false);
    expect(excluded.ip('nonsense')).toBe(false);
    expect(compileExclusions({ excludeIps: ['x'], excludePaths: [], excludeQueryParams: [] }).ip('1.2.3.4')).toBe(false);
  });
});

describe('excluded paths', () => {
  const excluded = compileExclusions({
    excludeIps: [],
    excludePaths: ['/admin', '/preview/*', '/*/draft'],
    excludeQueryParams: [],
  });

  it('matches a path exactly, and a star for one segment', () => {
    expect(excluded.path('/admin')).toBe(true);
    expect(excluded.path('/admin/users')).toBe(false);
    expect(excluded.path('/preview/post-1')).toBe(true);
    expect(excluded.path('/preview/a/b')).toBe(false);
    expect(excluded.path('/en/draft')).toBe(true);
    expect(excluded.path('/draft')).toBe(false);
    expect(excluded.path(undefined)).toBe(false);
  });
});

describe('excluded query parameters', () => {
  const excluded = compileExclusions({
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: ['sid', 'token'],
  });

  it('takes the named parameters out and leaves the rest in order', () => {
    expect(excluded.strip('/app?sid=abc&page=2&token=x')).toBe('/app?page=2');
    expect(excluded.strip('https://ref.example/a?token=1&utm_source=x')).toBe(
      'https://ref.example/a?utm_source=x',
    );
  });

  it('drops the question mark when nothing is left, and keeps a fragment', () => {
    expect(excluded.strip('/app?sid=abc')).toBe('/app');
    expect(excluded.strip('/app?sid=abc#top')).toBe('/app#top');
    expect(excluded.strip('/app?sid=abc&x=1#top')).toBe('/app?x=1#top');
  });

  it('leaves a value with no query string, or no rule, exactly as it was', () => {
    expect(excluded.strip('/app')).toBe('/app');
    expect(excluded.strip('/app#sid=abc')).toBe('/app#sid=abc');
    const none = compileExclusions({ excludeIps: [], excludePaths: [], excludeQueryParams: [] });
    expect(none.strip('/app?sid=abc')).toBe('/app?sid=abc');
  });

  it('reads an encoded parameter name as the name it encodes', () => {
    expect(excluded.strip('/app?s%69d=1&a=2')).toBe('/app?a=2');
  });
});

describe('what the settings may take', () => {
  it('accepts an address or a range and refuses anything else', () => {
    expect(isAddressRule('103.87.12.9')).toBe(true);
    expect(isAddressRule('10.0.0.0/8')).toBe(true);
    expect(isAddressRule('2001:db8::/32')).toBe(true);
    expect(isAddressRule('office')).toBe(false);
    expect(isAddressRule('10.0.0.0/99')).toBe(false);
  });

  it('accepts an absolute path and refuses a relative one or whitespace', () => {
    expect(isPathRule('/preview/*')).toBe(true);
    expect(isPathRule('preview')).toBe(false);
    expect(isPathRule('/a b')).toBe(false);
  });
});
