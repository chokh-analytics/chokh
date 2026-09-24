import ipaddr from 'ipaddr.js';

import { goalPattern, type SiteSettings } from '../store/AnalyticsStore.js';

// A site's own traffic, kept out: its addresses, its paths and the query
// parameters it does not want in a report. Read off the site row, compiled
// once per batch, applied by the collector before a row is derived from an
// event, so an excluded address never becomes a visitor and an excluded path
// never a pageview.
//
// An address is exact or a CIDR, the way TRUST_PROXY is written; a path is
// the goal grammar, where * is any run of characters inside one segment; a
// parameter is stripped off any path or referrer that carries a query string.
// The tracker never sends the page's own query string (router.ts keeps only
// the UTM parameters, as attributes), so that last list is for hash routes,
// server events and referrers, and the settings page says so.

export interface Exclusions {
  // Whether the batch's address is one the site excludes.
  ip(address: string | undefined): boolean;
  // Whether a path is one the site excludes.
  path(path: string | undefined): boolean;
  // The value with the excluded query parameters taken out of its query
  // string, and the value itself when it has none.
  strip(value: string): string;
}

type Range = ReturnType<typeof ipaddr.parseCIDR>;

// An exact address as the one-address range, so one match answers both.
function parseRange(rule: string): Range | null {
  try {
    if (rule.includes('/')) {
      return ipaddr.parseCIDR(rule);
    }
    const address = ipaddr.process(rule);
    return [address, address.kind() === 'ipv4' ? 32 : 128];
  } catch {
    // A rule that is not an address excludes nobody rather than everybody. The
    // schema refuses one before it is stored; this is the belt to that.
    return null;
  }
}

// Whether the settings may take this as an address rule.
export function isAddressRule(rule: string): boolean {
  return parseRange(rule) !== null;
}

// Whether the settings may take this as a path rule: an absolute path.
export function isPathRule(rule: string): boolean {
  return rule.startsWith('/') && !/\s/.test(rule);
}

function parameterName(pair: string): string {
  const raw = pair.split('=')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function compileExclusions(
  settings: Pick<SiteSettings, 'excludeIps' | 'excludePaths' | 'excludeQueryParams'>,
): Exclusions {
  const ranges = settings.excludeIps
    .map(parseRange)
    .filter((range): range is Range => range !== null);
  const paths = settings.excludePaths.map((rule) =>
    rule.includes('*') ? new RegExp(goalPattern(rule)) : rule,
  );
  const params = new Set(settings.excludeQueryParams);

  return {
    ip(address) {
      if (address === undefined || ranges.length === 0) {
        return false;
      }
      let parsed: ReturnType<typeof ipaddr.process>;
      try {
        parsed = ipaddr.process(address);
      } catch {
        return false;
      }
      return ranges.some((range) => parsed.kind() === range[0].kind() && parsed.match(range));
    },

    path(path) {
      if (path === undefined) {
        return false;
      }
      return paths.some((rule) => (typeof rule === 'string' ? rule === path : rule.test(path)));
    },

    strip(value) {
      const at = value.indexOf('?');
      if (params.size === 0 || at === -1) {
        return value;
      }
      const hashAt = value.indexOf('#', at);
      const query = hashAt === -1 ? value.slice(at + 1) : value.slice(at + 1, hashAt);
      const tail = hashAt === -1 ? '' : value.slice(hashAt);
      const kept = query.split('&').filter((pair) => pair !== '' && !params.has(parameterName(pair)));
      return value.slice(0, at) + (kept.length === 0 ? '' : `?${kept.join('&')}`) + tail;
    },
  };
}
