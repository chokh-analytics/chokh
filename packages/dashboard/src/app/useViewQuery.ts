import { useCallback, useMemo } from 'react';
import { useLocation, useSearch } from 'wouter';

import { parseQuery, requestedGoal, toSearch, type ViewQuery } from '../lib/query.js';
import { useApp } from './context.js';

// The URL is the state, and this is the only way to read or change it.
//
// Nothing in this dashboard keeps a copy of the range or the filters in a
// component: there is one place that holds them, it is the address bar, and
// every view is therefore a link somebody can send. A second copy in a hook
// would be a second thing to keep in step, and the one that lost would be the
// one a person had just shared.

export interface ViewQueryHandle {
  query: ViewQuery;
  // A real navigation: back and forward step through filter states, which is
  // what a person expects from clicking rows to narrow a report.
  set(next: ViewQuery): void;
  // A correction rather than a choice: normalising a window, filling a default.
  // It does not become a step in the history, because nobody wants to press
  // back and land on a URL they never typed.
  replace(next: ViewQuery): void;
  // The goal the link named, which query.goal is only when the site still has
  // it. The range bar says so when the two differ.
  requestedGoal: string | null;
}

export function useViewQuery(): ViewQueryHandle {
  const { site, now, goals } = useApp();
  const search = useSearch();
  const [location, navigate] = useLocation();

  const goalIds = useMemo(() => goals?.map((goal) => goal.id), [goals]);
  const query = useMemo(
    () => parseQuery(search, now, site.settings.timezone, goalIds),
    [search, now, site.settings.timezone, goalIds],
  );

  const go = useCallback(
    (next: ViewQuery, replace: boolean) => {
      const target = `${location}${toSearch(next)}`;
      // A choice that changes nothing is not a step. Pressing the metric tile
      // that is already selected, or re-applying the range that is already on,
      // used to push the same URL again: back then went to the same page, and
      // a person pressing back four times sat on the same screen four times.
      if (target === `${location}${search === '' ? '' : `?${search}`}`) {
        return;
      }
      navigate(target, { replace });
    },
    [location, navigate, search],
  );

  return {
    query,
    set: useCallback((next: ViewQuery) => go(next, false), [go]),
    replace: useCallback((next: ViewQuery) => go(next, true), [go]),
    requestedGoal: useMemo(() => requestedGoal(search), [search]),
  };
}
