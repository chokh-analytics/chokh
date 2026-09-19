import type {
  AggregateResult,
  BreakdownResult,
  EngagementResult,
  RealtimeSnapshot,
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

export interface Me {
  actor: { kind: 'session' | 'key'; id: string };
  user: PublicUser | null;
  sites: PublicSite[];
  teams: MyTeam[];
}

export interface CreatedSite {
  site: PublicSite;
  // Returned exactly here and once more by the rotate route, and by no GET
  // anywhere. The page that shows it says so.
  identifySecret: string;
  once: string;
}

function statsQuery(params: StatsParams): Params {
  return { ...params };
}

export const api = {
  me: (client: Client): Promise<Answer<Me>> => client.get<Me>('/api/me'),

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
