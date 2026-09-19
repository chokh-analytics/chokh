import { QueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Dimension } from '@chokh/store/contract';

import { api, type Me } from './api.js';
import { isRetryable, type Answer, type Client } from './client.js';
import { cacheKey, toStatsParams, type ViewQuery } from './query.js';
import { isLive } from './range.js';

// When the dashboard asks again.
//
// Two rules, and both come from what the number means rather than from a
// convention. A window that has already closed cannot change, so it is read
// once and kept. A window that runs up to now is still moving, so it is asked
// again while somebody is looking at it and never while they are not: a
// dashboard left open overnight should not be a load test, which is the lesson
// the admin panel learned about its own realtime page.
export const HISTORY_STALE_MS = 60_000;
export const LIVE_STALE_MS = 30_000;
export const LIVE_REFETCH_MS = 30_000;
export const REALTIME_POLL_MS = 5_000;
export const ME_STALE_MS = 5 * 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A 4xx is an answer and will be the same answer next time. Retrying it
        // turns one refusal into three and delays the message somebody has to
        // read by a second and a half.
        retry: (attempt, error) => attempt < 1 && isRetryable(error),
        refetchOnWindowFocus: true,
        // Left at the default on purpose. Set to false, a report that has gone
        // stale while somebody was on another page stays stale when they come
        // back to it, because a remount is the one moment a page has to ask
        // again. staleTime is what stops this being a refetch per navigation.
        refetchOnMount: true,
        // Nothing polls behind a hidden tab.
        refetchIntervalInBackground: false,
      },
    },
  });
}

function liveness(query: ViewQuery, now: number): { staleTime: number; refetchInterval: number | false } {
  return isLive(query.range, now)
    ? { staleTime: LIVE_STALE_MS, refetchInterval: LIVE_REFETCH_MS }
    : { staleTime: HISTORY_STALE_MS, refetchInterval: false };
}

export interface ReportContext {
  client: Client;
  siteId: string;
  query: ViewQuery;
  now: number;
}

export function useMe(client: Client): UseQueryResult<Answer<Me>> {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(client),
    // Who somebody is barely changes while they read a chart, but "barely" is
    // not "never": a membership or a new site should arrive without a reload,
    // and an infinite staleTime also means this query never re-renders the
    // component that holds the clock every range is resolved against.
    staleTime: ME_STALE_MS,
    retry: false,
  });
}

export function useAggregate(context: ReportContext) {
  const params = toStatsParams(context.query);
  return useQuery({
    queryKey: ['aggregate', ...cacheKey(context.siteId, params)],
    queryFn: () => api.aggregate(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

export function useTimeseries(context: ReportContext) {
  const params = toStatsParams(context.query);
  return useQuery({
    queryKey: ['timeseries', ...cacheKey(context.siteId, params)],
    queryFn: () => api.timeseries(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

export function useBreakdown(context: ReportContext, dim: Dimension, limit?: number) {
  const params = toStatsParams(context.query, { dim, limit });
  return useQuery({
    queryKey: ['breakdown', ...cacheKey(context.siteId, params)],
    queryFn: () => api.breakdown(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

export function useEngagement(context: ReportContext, dim: Dimension, limit?: number) {
  const params = toStatsParams(context.query, { dim, limit });
  return useQuery({
    queryKey: ['engagement', ...cacheKey(context.siteId, params)],
    queryFn: () => api.engagement(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

// Who is here now, polled. The Overview asks for this once every ten seconds
// for one tile; the Realtime page opens the stream instead and only falls back
// to this. Both read the same shape, because a frame of the stream carries the
// same envelope a poll does, which is why the server framed it that way.
export function useRealtime(client: Client, siteId: string, everyMs = REALTIME_POLL_MS) {
  return useQuery({
    queryKey: ['realtime', siteId],
    queryFn: () => api.realtime(client, siteId),
    staleTime: 0,
    refetchInterval: everyMs,
  });
}
