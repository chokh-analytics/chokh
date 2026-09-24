import type { StoredEvent } from './types.js';

// Route grouping: a site's dynamic pages reported as one row.
//
// A rule is a path pattern such as /courses/:slug, and every pageview whose
// path matches it is reported under the pattern itself, in the route
// dimension. The grammar is the goal grammar plus a named segment: a segment
// that is :name matches exactly one non-empty segment, a * inside a segment
// matches any run of characters short of a slash, and everything else is
// itself. Rules are ordered and the first match wins; a path no rule matches
// is its own route, so the route report is the page report with the dynamic
// pages folded.
//
// The route is stamped on the row at ingest, from the site's rules as they
// were then, and rewritten by regroupRoutes when the rules change. Nothing
// computes it at read time: a stored field is what lets both adapters agree by
// construction, a filter on it be an ordinary condition on an ordinary field,
// and a rollup of the dimension be a rollup like any other. The price is one
// more string per row, paid so that a report never has to know the rules.

export const MAX_ROUTE_GROUPS = 100;
export const MAX_ROUTE_RULE_LENGTH = 256;

// A rule the settings accept: an absolute path with no query, no fragment and
// no whitespace, short enough to be a path.
export function isRouteRule(rule: string): boolean {
  return (
    rule.length > 0 &&
    rule.length <= MAX_ROUTE_RULE_LENGTH &&
    rule.startsWith('/') &&
    !/[?#\s]/.test(rule)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NAMED_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/;

// A rule as an anchored pattern. One function, so the in-memory adapter's
// RegExp and MongoDB's $regexMatch are the same pattern.
export function routePattern(rule: string): string {
  const segments = rule
    .split('/')
    .map((segment) =>
      NAMED_SEGMENT.test(segment)
        ? '[^/]+'
        : segment.split('*').map(escapeRegex).join('[^/]*'),
    );
  return `^${segments.join('/')}$`;
}

export interface RouteMatcher {
  rule: string;
  pattern: RegExp;
}

// The rules compiled once, for a batch or a regroup.
export function routeMatchers(rules: readonly string[]): RouteMatcher[] {
  return rules.map((rule) => ({ rule, pattern: new RegExp(routePattern(rule)) }));
}

// The route of a path: the first rule it matches, else the path itself.
export function routeOf(path: string, matchers: readonly RouteMatcher[]): string {
  for (const matcher of matchers) {
    if (matcher.pattern.test(path)) {
      return matcher.rule;
    }
  }
  return path;
}

// The same row with its route stamped, or with none when it has no path: an
// identify or a server event with nothing to group is in no route.
export function withRoute(event: StoredEvent, matchers: readonly RouteMatcher[]): StoredEvent {
  if (event.path === undefined) {
    if (event.route === undefined) {
      return event;
    }
    const { route: _route, ...rest } = event;
    return rest;
  }
  return { ...event, route: routeOf(event.path, matchers) };
}

// Whether two rule lists are the same rules in the same order, which is the
// question updateSite asks before it marks a site for a regroup.
export function sameRouteRules(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((rule, index) => rule === right[index]);
}
