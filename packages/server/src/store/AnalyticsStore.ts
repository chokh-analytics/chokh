import type { GeoLocation, UserAgentInfo } from '@chokh/geo';

// The one door to storage. Services ask this interface and never a driver, so
// an adapter can be swapped without touching a report. AN-STO01 adds the read
// side (aggregate, timeseries, breakdown, realtime, visitor, user, rollupDay,
// purge) and the conformance suite every adapter must pass; the collector needs
// only these two.

export type IpMode = 'full' | 'anonymized' | 'none';
export type VisitorIdMode = 'cookieless' | 'persistent';

export interface SiteSettings {
  ipMode: IpMode;
  visitorIdMode: VisitorIdMode;
  botFilter: boolean;
}

export interface Site {
  id: string;
  name: string;
  domains: string[];
  settings: SiteSettings;
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

export interface AnalyticsStore {
  site(siteId: string): Promise<Site | null>;
  ingest(events: StoredEvent[]): Promise<void>;
}
