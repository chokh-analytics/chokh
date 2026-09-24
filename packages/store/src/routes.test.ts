import { describe, expect, it } from 'vitest';

import {
  MAX_ROUTE_RULE_LENGTH,
  isRouteRule,
  routeMatchers,
  routeOf,
  routePattern,
  sameRouteRules,
  withRoute,
} from './routes.js';
import type { StoredEvent } from './types.js';

// The grammar, decided in the contract so both adapters fold the same paths:
// the in-memory adapter runs routeOf and MongoDB is handed routePattern as its
// $regexMatch.

function row(over: Partial<StoredEvent>): StoredEvent {
  return {
    siteId: 's',
    ts: 0,
    receivedAt: 0,
    type: 'pageview',
    visitorId: 'v',
    bot: false,
    ...over,
  };
}

describe('routePattern', () => {
  it('lets a named segment stand for exactly one non-empty segment', () => {
    const pattern = new RegExp(routePattern('/courses/:slug'));
    expect(pattern.test('/courses/competitive-programming')).toBe(true);
    expect(pattern.test('/courses/c')).toBe(true);
    expect(pattern.test('/courses/')).toBe(false);
    expect(pattern.test('/courses')).toBe(false);
    expect(pattern.test('/courses/a/b')).toBe(false);
    expect(pattern.test('/en/courses/a')).toBe(false);
  });

  it('keeps the goal grammar for a star and treats everything else as itself', () => {
    expect(new RegExp(routePattern('/learn/*/lesson')).test('/learn/c/lesson')).toBe(true);
    expect(new RegExp(routePattern('/learn/*/lesson')).test('/learn//lesson')).toBe(true);
    expect(new RegExp(routePattern('/learn/*/lesson')).test('/learn/a/b/lesson')).toBe(false);
    expect(new RegExp(routePattern('/v1.0/x')).test('/v1.0/x')).toBe(true);
    expect(new RegExp(routePattern('/v1.0/x')).test('/v1_0/x')).toBe(false);
    expect(new RegExp(routePattern('/a(b)/:c')).test('/a(b)/d')).toBe(true);
  });

  it('takes two named segments, and a colon that is not a name as itself', () => {
    expect(new RegExp(routePattern('/learn/:course/:lesson')).test('/learn/c/pointers')).toBe(true);
    expect(new RegExp(routePattern('/learn/:course/:lesson')).test('/learn/c')).toBe(false);
    expect(new RegExp(routePattern('/at/:')).test('/at/:')).toBe(true);
    expect(new RegExp(routePattern('/at/:')).test('/at/x')).toBe(false);
  });
});

describe('routeOf', () => {
  const matchers = routeMatchers(['/courses/:slug', '/courses/*', '/learn/:course/:lesson']);

  it('answers the first rule that matches, in the order the site gave them', () => {
    expect(routeOf('/courses/c', matchers)).toBe('/courses/:slug');
    expect(routeOf('/learn/c/pointers', matchers)).toBe('/learn/:course/:lesson');
  });

  it('answers the path itself when no rule matches', () => {
    expect(routeOf('/pricing', matchers)).toBe('/pricing');
    expect(routeOf('/courses/c/reviews', matchers)).toBe('/courses/c/reviews');
    expect(routeOf('/pricing', [])).toBe('/pricing');
  });

  it('lets a rule that is a prefix of another win only where it matches', () => {
    const ordered = routeMatchers(['/courses', '/courses/:slug']);
    expect(routeOf('/courses', ordered)).toBe('/courses');
    expect(routeOf('/courses/c', ordered)).toBe('/courses/:slug');
  });
});

describe('withRoute', () => {
  const matchers = routeMatchers(['/courses/:slug']);

  it('stamps the route beside the path and leaves a row with no path unstamped', () => {
    expect(withRoute(row({ path: '/courses/c' }), matchers).route).toBe('/courses/:slug');
    expect(withRoute(row({ path: '/home' }), matchers).route).toBe('/home');
    expect(withRoute(row({ type: 'identify' }), matchers).route).toBeUndefined();
  });

  it('takes a stale route off a row that has lost its path', () => {
    const stale = withRoute(row({ type: 'identify', route: '/old' }), matchers);
    expect('route' in stale).toBe(false);
  });
});

describe('isRouteRule', () => {
  it('accepts an absolute path and refuses a query, a fragment, whitespace or nothing', () => {
    expect(isRouteRule('/courses/:slug')).toBe(true);
    expect(isRouteRule('/')).toBe(true);
    expect(isRouteRule('courses/:slug')).toBe(false);
    expect(isRouteRule('/a?b=c')).toBe(false);
    expect(isRouteRule('/a#b')).toBe(false);
    expect(isRouteRule('/a b')).toBe(false);
    expect(isRouteRule('')).toBe(false);
    expect(isRouteRule(`/${'a'.repeat(MAX_ROUTE_RULE_LENGTH)}`)).toBe(false);
  });
});

describe('sameRouteRules', () => {
  it('is order-sensitive, because the first match wins', () => {
    expect(sameRouteRules(['/a', '/b'], ['/a', '/b'])).toBe(true);
    expect(sameRouteRules(['/a', '/b'], ['/b', '/a'])).toBe(false);
    expect(sameRouteRules([], [])).toBe(true);
    expect(sameRouteRules(['/a'], [])).toBe(false);
  });
});
