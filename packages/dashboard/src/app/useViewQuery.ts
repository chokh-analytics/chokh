import { useCallback, useMemo } from 'react';
import { useLocation, useSearch } from 'wouter';

import {
  PARAM,
  parseQuery,
  requestedGoal,
  requestedVs,
  toSearch,
  type ViewQuery,
} from '../lib/query.js';
import { useApp } from './context.js';

const VIEW_PARAMS = new Set<string>(Object.values(PARAM));

// The parameters a page keeps for itself, carried through a change of view.
//
// Which tab of a card is open, which funnel is drawn and how many branches a
// flow keeps are not part of the view, but they are part of what somebody is
// looking at. Dropped on every range or filter change, a click on a row of the
// Referrers tab filtered Sources and put the card back on Channels, and a
// funnel chosen in a link was forgotten the moment the range moved. They go
// after the view's own, in the order they were in.
export function withPageParams(view: string, current: string): string {
  const params = new URLSearchParams(view);
  for (const [key, value] of new URLSearchParams(current)) {
    if (!VIEW_PARAMS.has(key)) {
      params.append(key, value);
    }
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

function sameParams(left: string, right: string): boolean {
  const one = new URLSearchParams(left);
  const other = new URLSearchParams(right);
  one.sort();
  other.sort();
  return one.toString() === other.toString();
}

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
  // The segment the link compares against, likewise.
  requestedVs: string | null;
}

export function useViewQuery(): ViewQueryHandle {
  const { site, now, goals, segments } = useApp();
  const search = useSearch();
  const [location, navigate] = useLocation();

  const goalIds = useMemo(() => goals?.map((goal) => goal.id), [goals]);
  const segmentIds = useMemo(() => segments?.map((segment) => segment.id), [segments]);
  const query = useMemo(
    () => parseQuery(search, now, site.settings.timezone, goalIds, segmentIds),
    [search, now, site.settings.timezone, goalIds, segmentIds],
  );

  const go = useCallback(
    (next: ViewQuery, replace: boolean) => {
      const nextSearch = withPageParams(toSearch(next), search);
      // A choice that changes nothing is not a step. Pressing the metric tile
      // that is already selected, or re-applying the range that is already on,
      // used to push the same URL again: back then went to the same page, and
      // a person pressing back four times sat on the same screen four times.
      // Compared as a set of parameters, because a page parameter typed ahead
      // of the view's own is the same link in another order.
      if (sameParams(nextSearch, search)) {
        return;
      }
      navigate(`${location}${nextSearch}`, { replace });
    },
    [location, navigate, search],
  );

  return {
    query,
    set: useCallback((next: ViewQuery) => go(next, false), [go]),
    replace: useCallback((next: ViewQuery) => go(next, true), [go]),
    requestedGoal: useMemo(() => requestedGoal(search), [search]),
    requestedVs: useMemo(() => requestedVs(search), [search]),
  };
}
