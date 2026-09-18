import type { GeoLocation, UserAgentInfo } from '@chokh/geo';

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
  // Declared by AN-STO01 so the shape is settled. The collector applies them
  // when AN-SEG01 gives a site owner somewhere to set them.
  excludeIps: string[];
  excludePaths: string[];
  excludeQueryParams: string[];
}

export interface Site {
  id: string;
  name: string;
  domains: string[];
  settings: SiteSettings;
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
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
    ...overrides,
  };
}

export type EventType = 'pageview' | 'event' | 'heartbeat' | 'leave' | 'identify' | 'vital';

export type Attributes = Record<string, string>;

export interface StoredEvent {
  siteId: string;
  // The browser's clock, bounded to the arrival time by the collector.
  ts: number;
  receivedAt: number;
  type: EventType;
  visitorId: string;
  // Written by AN-SES01, which owns the 30 minute gap rule.
  sessionId?: string;
  userId?: string;
  path?: string;
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
  name?: string;
  props?: Attributes;
  traits?: Attributes;
  duration?: number;
  scrollDepth?: number;
  value?: number;
  rating?: string;
}

// A visitor's stay, written by AN-SES01. AN-STO01 declares and indexes the
// collection and reads it; until sessions exist every number derived from one
// reads zero, and nothing here is rewritten when they arrive.
export interface StoredSession {
  siteId: string;
  id: string;
  visitorId: string;
  userId?: string;
  startedAt: number;
  lastSeenAt: number;
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

// The person behind the sessions, written by AN-SES01.
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
  devices: string[];
  ips: string[];
}
