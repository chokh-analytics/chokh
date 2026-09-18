import type { Props } from './types';

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];

export interface PathParts {
  pathname: string;
  hash: string;
}

// The path a report groups by. The query string is carried as UTM only, so one
// page is one row whatever the campaign.
export function pagePath(loc: PathParts, hashRouting: boolean): string {
  return loc.pathname + (hashRouting ? loc.hash : '');
}

export function readUtm(search: string): Props | undefined {
  if (search === '' || search.indexOf('utm_') < 0) {
    return undefined;
  }
  const params = new URLSearchParams(search);
  const utm: Props = {};
  let found = false;
  for (const name of UTM_KEYS) {
    const value = params.get('utm_' + name);
    if (value !== null && value !== '') {
      utm[name] = value;
      found = true;
    }
  }
  return found ? utm : undefined;
}

// A single page app changes the URL without a document load, so history is
// patched and popstate watched. Hash routing is opt in because a site that uses
// the hash for anchors would otherwise count a pageview per jump link.
export function watchNavigation(win: Window, hashRouting: boolean, onChange: () => void): void {
  const history = win.history;
  const patch = (name: 'pushState' | 'replaceState'): void => {
    const original = history[name];
    if (typeof original !== 'function') {
      return;
    }
    history[name] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      onChange();
      return result;
    };
  };
  patch('pushState');
  patch('replaceState');
  win.addEventListener('popstate', onChange);
  if (hashRouting) {
    win.addEventListener('hashchange', onChange);
  }
}
