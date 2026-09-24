import { QueryClient, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Dimension, Segment } from '@chokh/store/contract';

import { api, type LicenseStatus, type Me } from './api.js';
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

// What this install may run.
//
// One read for the whole session. A licence does not change while somebody
// reads a chart, and the answer decides whether a feature is drawn with its
// "part of Chokh Pro" label or drawn for real, which is a decision every page
// that has a paid feature on it needs and none of them should ask for twice.
//
// A failure is not an error anybody has to see. The worst case is a label that
// is shown when it did not need to be, and a card that says a feature is part
// of Chokh Pro on an install that has bought it is a great deal better than a
// page that refuses to draw because one small read failed.
export function useLicense(client: Client): UseQueryResult<Answer<LicenseStatus>> {
  return useQuery({
    queryKey: ['license'],
    queryFn: () => api.license(client),
    staleTime: ME_STALE_MS,
    retry: false,
  });
}

// A site's goals, for the picker and for vouching for the id in a link. Read on
// the same clock as who somebody is, because a goal changes about as often, and
// refreshed by hand after every create and delete, because a list that still
// offers a goal somebody has just removed is a list that lies for five minutes.
export function goalsKey(siteId: string): unknown[] {
  return ['goals', siteId];
}

export function useGoals(client: Client, siteId: string) {
  return useQuery({
    queryKey: goalsKey(siteId),
    queryFn: () => api.goals(client, siteId),
    staleTime: ME_STALE_MS,
    retry: false,
  });
}

// A site's segments, for the picker and for vouching for the id a link
// compares against. On the goal list's clock and refreshed by hand after every
// save and delete, for the goal list's reason.
export function segmentsKey(siteId: string): unknown[] {
  return ['segments', siteId];
}

export function useSegments(client: Client, siteId: string) {
  return useQuery({
    queryKey: segmentsKey(siteId),
    queryFn: () => api.segments(client, siteId),
    staleTime: ME_STALE_MS,
    retry: false,
  });
}

// The marks on the chart for the range on screen. Keyed by the range and not
// by the whole query, because a filter or a metric changes nothing about when
// a deploy happened. Refreshed by hand after every add and delete, for the
// goal list's reason, and otherwise on the history clock: a mark is a fact
// somebody stated, not a number that moves.
export function annotationsKey(siteId: string, from?: number, to?: number): unknown[] {
  return from === undefined ? ['annotations', siteId] : ['annotations', siteId, from, to];
}

export function useAnnotations(context: ReportContext) {
  const { from, to } = context.query.range;
  return useQuery({
    queryKey: annotationsKey(context.siteId, from, to),
    queryFn: () => api.annotations(context.client, context.siteId, from, to),
    staleTime: HISTORY_STALE_MS,
    retry: false,
  });
}

// A site's funnels, for the Funnels page. On the goal list's clock and refreshed
// by hand after every create and delete, for the goal list's reason.
export function funnelsKey(siteId: string): unknown[] {
  return ['funnels', siteId];
}

export function useFunnels(client: Client, siteId: string) {
  return useQuery({
    queryKey: funnelsKey(siteId),
    queryFn: () => api.funnels(client, siteId),
    staleTime: ME_STALE_MS,
    retry: false,
  });
}

// The totals, and with a goal chosen the share of them that reached it. The
// only other read that takes the goal is a breakdown that draws it.
export function useAggregate(context: ReportContext) {
  const params = toStatsParams(context.query, { goal: true });
  return useQuery({
    queryKey: ['aggregate', ...cacheKey(context.siteId, params)],
    queryFn: () => api.aggregate(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

// Never with the goal. The server refuses one on a time series, so a chart that
// carried it would draw nothing at all the moment somebody chose a goal; the
// chart is visitors whatever the column beside the rows says.
export function useTimeseries(context: ReportContext) {
  const params = toStatsParams(context.query);
  return useQuery({
    queryKey: ['timeseries', ...cacheKey(context.siteId, params)],
    queryFn: () => api.timeseries(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

// The chart's second series while a segment is compared: the same range and
// interval, the segment's own filters in place of the ones on screen, and no
// previous period, which steps aside while a segment is on. Asked only while
// one is.
export function useSegmentTimeseries(context: ReportContext, segment: Segment | undefined) {
  const params = toStatsParams({
    ...context.query,
    filters: segment?.filters ?? [],
    compare: null,
  });
  return useQuery({
    queryKey: ['timeseries', ...cacheKey(context.siteId, params)],
    queryFn: () => api.timeseries(context.client, context.siteId, params),
    enabled: segment !== undefined,
    ...liveness(context.query, context.now),
  });
}

// withGoal is for a card that draws the conversion column. A read that only
// ranks, like the map's shading or the count of 404s, leaves it out and stays a
// rollup read.
export function useBreakdown(
  context: ReportContext,
  dim: Dimension,
  limit?: number,
  withGoal = false,
) {
  const params = toStatsParams(context.query, { dim, limit, goal: withGoal });
  return useQuery({
    queryKey: ['breakdown', ...cacheKey(context.siteId, params)],
    queryFn: () => api.breakdown(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

// Never with the goal either, for the same reason: the server refuses it.
export function useEngagement(context: ReportContext, dim: Dimension, limit?: number) {
  const params = toStatsParams(context.query, { dim, limit });
  return useQuery({
    queryKey: ['engagement', ...cacheKey(context.siteId, params)],
    queryFn: () => api.engagement(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

// Every goal's conversion, for the Goals page. Keyed under the site first so
// adding or deleting a goal can drop every range of it at once.
export function useGoalStats(context: ReportContext) {
  const params = toStatsParams(context.query);
  return useQuery({
    queryKey: ['goal-stats', context.siteId, ...cacheKey(context.siteId, params)],
    queryFn: () => api.goalStats(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

// How far the people of the range got through one funnel. Never with the
// goal: the server refuses one, and a funnel is its own question. The filters
// go, because they choose the people.
export function useFunnelStats(context: ReportContext, funnelId: string) {
  const params = toStatsParams(context.query);
  return useQuery({
    queryKey: ['funnel-stats', context.siteId, funnelId, ...cacheKey(context.siteId, params)],
    queryFn: () => api.funnelStats(context.client, context.siteId, params, funnelId),
    ...liveness(context.query, context.now),
  });
}

// The paths visits took, for the Journeys tab. Never with the goal either,
// and keyed by the branch count, which changes the answer.
export function useJourneys(context: ReportContext, branches: number) {
  const params = toStatsParams(context.query);
  return useQuery({
    queryKey: ['journeys', branches, ...cacheKey(context.siteId, params)],
    queryFn: () => api.journeys(context.client, context.siteId, params, branches),
    ...liveness(context.query, context.now),
  });
}

// The events report and a property breakdown. Neither takes the goal: the server
// refuses one on both, and a list of events counted against a goal is not a
// question the page asks.
export function useEvents(context: ReportContext, limit?: number) {
  const params = toStatsParams(context.query, { limit });
  return useQuery({
    queryKey: ['events', ...cacheKey(context.siteId, params)],
    queryFn: () => api.events(context.client, context.siteId, params),
    ...liveness(context.query, context.now),
  });
}

export function useProperties(
  context: ReportContext,
  event: string | null,
  property: string | null,
) {
  const params = toStatsParams(context.query);
  return useQuery({
    queryKey: ['properties', event, property, ...cacheKey(context.siteId, params)],
    queryFn: () =>
      api.properties(context.client, context.siteId, params, event as string, property),
    enabled: event !== null,
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
