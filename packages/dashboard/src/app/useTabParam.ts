import { useCallback } from 'react';
import { useLocation, useSearch } from 'wouter';

// Which tab of a report is open, kept in the URL like everything else.
//
// A report with three tabs is three views, and all three are worth sending to
// somebody. Keeping the choice in component state would make two of them
// unlinkable and would lose the choice on a reload, which is the same argument
// as for the range and the filters: there is one place this dashboard keeps
// what somebody is looking at, and it is the address bar.
//
// An unknown value falls back to the first tab rather than throwing, because a
// URL is something anybody can edit and a page that refuses to load because a
// character is wrong is worse than one that loads on the default tab.

export interface TabHandle<T extends string> {
  tab: T;
  set(next: T): void;
}

export function useTabParam<T extends string>(name: string, tabs: readonly T[]): TabHandle<T> {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const raw = params.get(name);
  const first = tabs[0] as T;
  const tab = tabs.includes(raw as T) ? (raw as T) : first;

  const set = useCallback(
    (next: T) => {
      const nextParams = new URLSearchParams(search);
      // The first tab is the default, so it is left out of the link entirely:
      // the common case is a short URL and what is in it is what somebody
      // chose.
      if (next === first) {
        nextParams.delete(name);
      } else {
        nextParams.set(name, next);
      }
      const text = nextParams.toString();
      const target = `${location}${text === '' ? '' : `?${text}`}`;
      if (target === `${location}${search === '' ? '' : `?${search}`}`) {
        return;
      }
      navigate(target);
    },
    [search, location, navigate, name, first],
  );

  return { tab, set };
}
