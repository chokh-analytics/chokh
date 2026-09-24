import type {
  AggregateResult,
  BreakdownResult,
  EngagementResult,
  EventsResult,
  Funnel,
  FunnelResult,
  FunnelWindow,
  Goal,
  GoalKind,
  GoalStatsResult,
  JourneyResult,
  PropertyResult,
  RealtimeSnapshot,
  Segment,
  TimeseriesResult,
  UserProfile,
  VisitorProfile,
} from '@chokh/store/contract';

import type { Answer, Client, Params } from './client.js';
import type { StatsParams } from './query.js';

// One function per route, with the response type imported from the store
// contract rather than redeclared here.
//
// That import is the point of the whole file. A change to what aggregate
// answers breaks this build rather than a page at runtime, and there is no
// second copy of a shape to drift from the first. It is the same discipline the
// backend keeps by importing the store's query type instead of writing its own.

// What the site row looks like on the wire: publicSite, which is the site with
// its identifySecret taken out.
export interface PublicSite {
  id: string;
  name: string;
  domains: string[];
  teamId: string;
  settings: {
    ipMode: 'full' | 'anonymized' | 'none';
    visitorIdMode: 'cookieless' | 'persistent';
    botFilter: boolean;
    retentionDays: number;
    timezone: string;
    allowUnsignedIdentify: boolean;
    excludeIps: string[];
    excludePaths: string[];
    excludeQueryParams: string[];
  };
}

export interface PublicUser {
  id: string;
  email: string;
  name?: string;
}

// A team this person belongs to, and what they are in it. Sites carry a teamId,
// but somebody with no sites yet is exactly the person who has to name one, so
// it cannot be derived from them.
export interface MyTeam {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
}

// What this install may run. Never the key itself, and the route needs a
// session: the licensee's name and the expiry say who runs this install and
// when they last paid.
export interface LicenseStatus {
  licensed: boolean;
  plan: string | null;
  licensee: string | null;
  // Unix milliseconds. Kept after a key runs out, so the dashboard can say
  // "expired on" rather than only "not licensed".
  expiresAt: number | null;
  features: string[];
}

export interface Me {
  actor: { kind: 'session' | 'key'; id: string };
  user: PublicUser | null;
  sites: PublicSite[];
  teams: MyTeam[];
}

export interface CreatedSite {
  site: PublicSite;
  // Under once, and not beside site, because that is the shape the server
  // answers with and the name is the point: everything in here leaves the
  // server exactly once. Declared flat here once, which is why the page that
  // promised to show the secret rendered nothing at all.
  once: {
    identifySecret: string;
  };
}

// The goals report as the route answers it: the store's result with each
// goal's record put back beside its conversion, so the page draws a name and
// not an id. A goal deleted between the two reads is a row with no record.
export interface GoalStatsView extends Omit<GoalStatsResult, 'rows'> {
  rows: { goal?: Goal; conversion: GoalStatsResult['rows'][number]['conversion'] }[];
}

// The funnel report as the route answers it: the store's result with the
// funnel's record beside it, so a page draws step names and not indexes.
export interface FunnelStatsView extends FunnelResult {
  funnel: Funnel;
}

// A funnel step as it is asked for: a goal of this site by id, or a typed path.
export type FunnelStepInput = { goalId: string } | { page: string };

function statsQuery(params: StatsParams): Params {
  return { ...params };
}

export const api = {
  me: (client: Client): Promise<Answer<Me>> => client.get<Me>('/api/me'),

  license: (client: Client): Promise<Answer<LicenseStatus>> =>
    client.get<LicenseStatus>('/api/license'),

  signIn: (client: Client, email: string, password: string): Promise<Answer<{ user: PublicUser }>> =>
    client.post<{ user: PublicUser }>('/api/auth/login', { email, password }),

  register: (
    client: Client,
    input: { email: string; password: string; name?: string },
  ): Promise<Answer<{ user: PublicUser; signedIn: boolean }>> =>
    client.post<{ user: PublicUser; signedIn: boolean }>('/api/auth/register', input),

  signOut: (client: Client): Promise<Answer<{ signedOut: boolean }>> =>
    client.post<{ signedOut: boolean }>('/api/auth/logout'),

  createSite: (
    client: Client,
    input: {
      name: string;
      domains: string[];
      // Only an owner of the named team may create a site in it, and the
      // server's default is the team called default. Somebody the SSO exchange
      // put in a team of their own owns that one and not this, so the team is
      // named rather than assumed.
      teamId?: string;
      settings?: { timezone?: string };
    },
  ): Promise<Answer<CreatedSite>> => client.post<CreatedSite>('/api/sites', input),

  aggregate: (client: Client, siteId: string, params: StatsParams): Promise<Answer<AggregateResult>> =>
    client.get<AggregateResult>(`/api/sites/${siteId}/stats/aggregate`, statsQuery(params)),

  timeseries: (
    client: Client,
    siteId: string,
    params: StatsParams,
  ): Promise<Answer<TimeseriesResult>> =>
    client.get<TimeseriesResult>(`/api/sites/${siteId}/stats/timeseries`, statsQuery(params)),

  breakdown: (client: Client, siteId: string, params: StatsParams): Promise<Answer<BreakdownResult>> =>
    client.get<BreakdownResult>(`/api/sites/${siteId}/stats/breakdown`, statsQuery(params)),

  engagement: (
    client: Client,
    siteId: string,
    params: StatsParams,
  ): Promise<Answer<EngagementResult>> =>
    client.get<EngagementResult>(`/api/sites/${siteId}/stats/engagement`, statsQuery(params)),

  // The site's goals, oldest first. Anybody who can read a report can read what
  // it is being measured against.
  goals: (client: Client, siteId: string): Promise<Answer<{ goals: Goal[] }>> =>
    client.get<{ goals: Goal[] }>(`/api/sites/${siteId}/goals`),

  // Adding and deleting a goal need an owner of the site's team; the server says
  // so with a 403 for anybody else, and the page says so before they try.
  createGoal: (
    client: Client,
    siteId: string,
    input: { name: string; kind: GoalKind; match: string; value?: number },
  ): Promise<Answer<{ goal: Goal }>> =>
    client.post<{ goal: Goal }>(`/api/sites/${siteId}/goals`, input),

  deleteGoal: (
    client: Client,
    siteId: string,
    goalId: string,
  ): Promise<Answer<{ deleted: boolean }>> =>
    client.delete<{ deleted: boolean }>(
      `/api/sites/${siteId}/goals/${encodeURIComponent(goalId)}`,
    ),

  // The site's segments, by name, readable by anybody who can read a report:
  // a segment is a saved filter list and every report already takes one.
  // Saving and deleting need an owner, like a goal.
  segments: (client: Client, siteId: string): Promise<Answer<{ segments: Segment[] }>> =>
    client.get<{ segments: Segment[] }>(`/api/sites/${siteId}/segments`),

  createSegment: (
    client: Client,
    siteId: string,
    input: { name: string; filters: Segment['filters'] },
  ): Promise<Answer<{ segment: Segment }>> =>
    client.post<{ segment: Segment }>(`/api/sites/${siteId}/segments`, input),

  deleteSegment: (
    client: Client,
    siteId: string,
    segmentId: string,
  ): Promise<Answer<{ deleted: boolean }>> =>
    client.delete<{ deleted: boolean }>(
      `/api/sites/${siteId}/segments/${encodeURIComponent(segmentId)}`,
    ),

  // The site's funnels, oldest first, readable by anybody who can read a
  // report. Adding and deleting one need an owner, like a goal.
  funnels: (client: Client, siteId: string): Promise<Answer<{ funnels: Funnel[] }>> =>
    client.get<{ funnels: Funnel[] }>(`/api/sites/${siteId}/funnels`),

  // A step is a goal of this site, copied into the funnel when it is created,
  // or a typed path. The window is left out to take the site's default.
  createFunnel: (
    client: Client,
    siteId: string,
    input: { name: string; window?: FunnelWindow; steps: FunnelStepInput[] },
  ): Promise<Answer<{ funnel: Funnel }>> =>
    client.post<{ funnel: Funnel }>(`/api/sites/${siteId}/funnels`, input),

  deleteFunnel: (
    client: Client,
    siteId: string,
    funnelId: string,
  ): Promise<Answer<{ deleted: boolean }>> =>
    client.delete<{ deleted: boolean }>(
      `/api/sites/${siteId}/funnels/${encodeURIComponent(funnelId)}`,
    ),

  // How far the people of the range got through one funnel. Raw only, and
  // never with a goal: the server refuses one.
  funnelStats: (
    client: Client,
    siteId: string,
    params: StatsParams,
    funnelId: string,
  ): Promise<Answer<FunnelStatsView>> =>
    client.get<FunnelStatsView>(`/api/sites/${siteId}/stats/funnel`, {
      ...statsQuery(params),
      funnel: funnelId,
    }),

  // The paths the range's visits took, each column folded to its most visited
  // pages. Raw only, and never with a goal.
  journeys: (
    client: Client,
    siteId: string,
    params: StatsParams,
    branches: number,
  ): Promise<Answer<JourneyResult>> =>
    client.get<JourneyResult>(`/api/sites/${siteId}/stats/journeys`, {
      ...statsQuery(params),
      branches,
    }),

  // Every goal of the site at once, each with its record and one conversion.
  goalStats: (
    client: Client,
    siteId: string,
    params: StatsParams,
  ): Promise<Answer<GoalStatsView>> =>
    client.get<GoalStatsView>(`/api/sites/${siteId}/stats/goals`, statsQuery(params)),

  // The custom events of the range by name, and one of them by a property.
  // Both raw only, and neither takes a goal.
  events: (client: Client, siteId: string, params: StatsParams): Promise<Answer<EventsResult>> =>
    client.get<EventsResult>(`/api/sites/${siteId}/stats/events`, statsQuery(params)),

  properties: (
    client: Client,
    siteId: string,
    params: StatsParams,
    event: string,
    property: string | null,
  ): Promise<Answer<PropertyResult>> =>
    client.get<PropertyResult>(`/api/sites/${siteId}/stats/properties`, {
      ...statsQuery(params),
      event,
      ...(property === null ? {} : { property }),
    }),

  realtime: (client: Client, siteId: string): Promise<Answer<RealtimeSnapshot>> =>
    client.get<RealtimeSnapshot>(`/api/sites/${siteId}/realtime`),

  visitor: (client: Client, siteId: string, visitorId: string): Promise<Answer<VisitorProfile>> =>
    client.get<VisitorProfile>(`/api/sites/${siteId}/visitors/${encodeURIComponent(visitorId)}`),

  user: (client: Client, siteId: string, userId: string): Promise<Answer<UserProfile>> =>
    client.get<UserProfile>(`/api/sites/${siteId}/users/${encodeURIComponent(userId)}`),

  // Not a JSON read: the browser navigates to it and the server sends a file.
  exportUrl: (client: Client, siteId: string, params: StatsParams): string =>
    client.url(`/api/sites/${siteId}/export.csv`, statsQuery(params)),

  // Not a JSON read either: an EventSource opens it and keeps it open.
  streamUrl: (client: Client, siteId: string): string =>
    client.url(`/api/sites/${siteId}/realtime/stream`),
};

// Whether a response carried the fields only read:identity unlocks. The server
// puts this in the meta rather than making a page guess from an absent field,
// because an absent address and a withheld one look identical and mean
// different things.
export function identityAllowed(meta: Record<string, unknown> | undefined): boolean {
  return meta?.identity === true;
}
