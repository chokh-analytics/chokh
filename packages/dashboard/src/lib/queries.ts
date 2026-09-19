import { QueryClient, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
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

// A profile is a fact about somebody's whole history, not about a range, so it
// does not go stale in the seconds a stats read does. Half a minute is long
// enough that walking back and forth between a profile and its timeline does
// not write two audit rows for one look.
export const PROFILE_STALE_MS = 30_000;

// How often a profile asks whether that person is still here. Slower than the
// Realtime page's own poll, because this is one badge beside a name rather
// than the report somebody is watching.
export const PROFILE_PRESENCE_MS = 15_000;
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
// everyMs false is a live stream having taken over: the query stays for the one
// thing the stream cannot carry, which is the meta saying whether this caller
// may read an address, and stops asking for what the stream is already sending.
export function useRealtime(
  client: Client,
  siteId: string,
  everyMs: number | false = REALTIME_POLL_MS,
) {
  return useQuery({
    queryKey: ['realtime', siteId],
    queryFn: () => api.realtime(client, siteId),
    staleTime: 0,
    refetchInterval: everyMs,
  });
}

// Has this site ever been visited at all?
//
// Asked only when the range on screen is empty, because that is the one moment
// the answer changes what is drawn: an empty week on a busy site is "nothing in
// this range", and an empty week on a site nobody has installed the script on
// is a different screen entirely. The window is the site's whole retention, the
// read is cached for the session, and nothing asks it on a site with numbers.
export function useHasAnyData(
  client: Client,
  site: { id: string; settings: { retentionDays: number } },
  now: number,
  when: boolean,
) {
  const from = now - site.settings.retentionDays * 24 * 60 * 60 * 1000;
  return useQuery({
    queryKey: ['any-data', site.id],
    queryFn: () => api.aggregate(client, site.id, { from, to: now }),
    enabled: when,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// One person, looked up by hand.
//
// Not cached beyond the session and never prefetched: a read that names
// somebody writes an audit row on the server, so asking speculatively would be
// writing "this account looked at this person" for a page nobody opened.
export function useVisitorProfile(client: Client, siteId: string, visitorId: string | null) {
  return useQuery({
    queryKey: ['visitor', siteId, visitorId],
    queryFn: () => api.visitor(client, siteId, visitorId as string),
    enabled: visitorId !== null,
    staleTime: PROFILE_STALE_MS,
    retry: false,
  });
}

export function useUserProfile(client: Client, siteId: string, userId: string | null) {
  return useQuery({
    queryKey: ['user', siteId, userId],
    queryFn: () => api.user(client, siteId, userId as string),
    enabled: userId !== null,
    staleTime: PROFILE_STALE_MS,
    retry: false,
  });
}

// How busy each site is, for the switcher.
//
// One read per site, and only while the list is open: the switcher mounts its
// own children when somebody opens it, so nothing here is asked for on a page
// where the list is shut. They share the ['realtime', siteId] key with the
// Overview tile, so opening the switcher on the site being read costs nothing.
export function useSiteCounts(client: Client, siteIds: string[]) {
  return useQueries({
    queries: siteIds.map((siteId) => ({
      queryKey: ['realtime', siteId],
      queryFn: () => api.realtime(client, siteId),
      staleTime: REALTIME_POLL_MS,
    })),
    combine: (results) => {
      const online = new Map<string, number>();
      results.forEach((result, index) => {
        const siteId = siteIds[index];
        if (siteId !== undefined && result.data !== undefined) {
          online.set(siteId, result.data.data.online);
        }
      });
      return { online, pending: results.some((result) => result.isPending) };
    },
  });
}
