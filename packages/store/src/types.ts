import type { GeoLocation, UserAgentInfo } from '@chokh/geo/types';

import type { Channel } from './channel.js';

export type IpMode = 'full' | 'anonymized' | 'none';
export type VisitorIdMode = 'cookieless' | 'persistent';

export interface SiteSettings {
  ipMode: IpMode;
  visitorIdMode: VisitorIdMode;
  botFilter: boolean;
  // How long a raw event lives. Rollups keep forever, so history survives the
  // purge; only the per-visitor detail ages out.
  retentionDays: number;
  // The zone every day boundary is drawn in: the rollup date keys, the split
  // between "today from raw rows" and "history from rollups", and the day,
  // week and month buckets of a time series. A site in Dhaka asking "how many
  // came today" means its own midnight, not UTC's, and a rollup key cannot be
  // changed once a year of them exists, so this is settled before the first
  // row is written. An IANA name, for example 'Asia/Dhaka'.
  timezone: string;
  // Whether a browser may name the person behind a visitor without proof.
  //
  // A page can call pa('identify', 'u_someone') with any id it likes, and the
  // collector has no way to tell a real login from a curious visitor typing
  // into the console. On a blog that is harmless and the feature should just
  // work, so the default is yes. On a site where an identified person's
  // profile shows their addresses and their pages to an administrator, a
  // forged identify is somebody reading another person's history, so that site
  // sets this to no and signs its identifies: sdk-node holds identifySecret on
  // the server, hands the page an HMAC of the userId, and the tracker passes it
  // back as the fourth argument of pa('identify'). An identify that is not
  // confirmed never reaches a visitor row, a merge or a per-user lookup.
  allowUnsignedIdentify: boolean;
  // The per-site key those signatures are made with. It never leaves the
  // server: a browser that could read it could sign anything.
  identifySecret?: string;
  // The site's own traffic, kept out by the collector before a row is derived:
  // addresses (exact or CIDR), paths (the goal grammar, * for one segment) and
  // the query parameters stripped off a path or a referrer that carries any.
  excludeIps: string[];
  excludePaths: string[];
  excludeQueryParams: string[];
  // Path patterns whose pageviews are reported as one row in the route
  // dimension, in order, first match wins: /courses/:slug. See routes.ts.
  routeGroups: string[];
}

export interface Site {
  id: string;
  name: string;
  domains: string[];
  // The team that owns it, and therefore who may read it. Optional because a
  // single tenant install never names one and the conformance fixture does not
  // either; a site without one is read as the default team's.
  teamId?: string;
  settings: SiteSettings;
  // Set by updateSite when routeGroups changed, cleared by regroupRoutes,
  // which the jobs run while it is set. Until then the stored route of every
  // row and the route rollups are from the rules as they were.
  routesChangedAt?: number;
}

// What a site gets when nobody has chosen. The public defaults, not Progsity's:
// an anonymised address, a visitor who does not outlive the day, and UTC.
export function defaultSiteSettings(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    ipMode: 'anonymized',
    visitorIdMode: 'cookieless',
    botFilter: true,
    retentionDays: 180,
    timezone: 'UTC',
    allowUnsignedIdentify: true,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
    routeGroups: [],
    ...overrides,
  };
}

export type EventType = 'pageview' | 'event' | 'heartbeat' | 'leave' | 'identify' | 'vital';

// Where an event came from. A browser unless it says otherwise; 'server' is an
// event an application sent through POST /api/sites/:siteId/events with a key,
// where the identity is trusted because a server presented it. A server event
// never puts anybody in the presence set: a receipt written by a backend is not
// a sign that somebody is at a keyboard.
export type EventSource = 'server';

export type Attributes = Record<string, string>;

export interface StoredEvent {
  siteId: string;
  // The browser's clock, bounded to the arrival time by the collector.
  ts: number;
  receivedAt: number;
  type: EventType;
  visitorId: string;
  // The stay this event belongs to, stamped by ingest under the 30 minute gap
  // rule in session.ts.
  sessionId?: string;
  userId?: string;
  path?: string;
  // The route the path is reported under: the first of the site's route rules
  // it matches, else the path itself. Stamped by ingest and rewritten by
  // regroupRoutes when the rules change; see routes.ts.
  route?: string;
  hostname?: string;
  title?: string;
  referrer?: string;
  utm?: Attributes;
  geo?: GeoLocation;
  ip?: string;
  ua?: UserAgentInfo;
  screen?: string;
  viewport?: string;
  lang?: string;
  bot: boolean;
  source?: EventSource;
  name?: string;
  // What the page said it answered, as three digits. Only a pageview carries
  // one, and only when the page declared it: a browser cannot read a response
  // code, so a pageview without this is a pageview nobody labelled and never a
  // 200.
  status?: string;
  props?: Attributes;
  traits?: Attributes;
  duration?: number;
  scrollDepth?: number;
  value?: number;
  rating?: string;
}

// A visitor's stay. Written by ingest through the fold in session.ts: one row
// per unbroken run of a visitor's events, and the source fields are the ones
// the stay came in with.
export interface StoredSession {
  siteId: string;
  id: string;
  visitorId: string;
  userId?: string;
  startedAt: number;
  lastSeenAt: number;
  // Set by a leave beacon: the visitor closed the page rather than going quiet.
  endedAt?: number;
  entryPath?: string;
  exitPath?: string;
  pageviews: number;
  events: number;
  duration: number;
  referrer?: string;
  channel?: string;
  utm?: Attributes;
  geo?: GeoLocation;
  ip?: string;
  ua?: UserAgentInfo;
  bot: boolean;
  isNew: boolean;
}

// Where a stay came from, kept on the visitor so attribution can ask either
// "what first brought them here" or "what brought them back".
export interface Touch {
  at: number;
  channel: Channel;
  referrer?: string;
  utm?: Attributes;
  entryPath?: string;
}

// How many sessions opened in one place. The tally behind homeGeo, capped, so
// "where they usually connect from" is a count and not the latest guess.
export interface PlaceTally {
  key: string;
  count: number;
  geo: GeoLocation;
}

// The person behind the sessions.
export interface StoredVisitor {
  siteId: string;
  id: string;
  userId?: string;
  traits?: Attributes;
  firstSeenAt: number;
  lastSeenAt: number;
  sessions: number;
  pageviews: number;
  homeGeo?: GeoLocation;
  places: PlaceTally[];
  devices: string[];
  ips: string[];
  firstTouch?: Touch;
  lastTouch?: Touch;
}
