export type EventType = 'pageview' | 'event' | 'heartbeat' | 'leave' | 'identify' | 'vital';

export type Props = Record<string, string>;

export interface TrackedEvent {
  type: EventType;
  ts: number;
  path?: string;
  title?: string;
  referrer?: string;
  utm?: Props;
  name?: string;
  props?: Props;
  userId?: string;
  traits?: Props;
  duration?: number;
  scrollDepth?: number;
  value?: number;
  rating?: string;
}

export interface Batch {
  siteId: string;
  sentAt: number;
  hostname: string;
  lang?: string;
  screen?: string;
  viewport?: string;
  visitorId?: string;
  userId?: string;
  events: TrackedEvent[];
}

export interface Context {
  visitorId?: string;
  userId?: string;
}

export interface Config {
  siteId: string;
  collectUrl: string;
  hashRouting: boolean;
  persistentVisitor: boolean;
  honourDnt: boolean;
  requireConsent: boolean;
}

export type Pa = ((command: string, ...args: unknown[]) => void) & {
  q?: ArrayLike<unknown>[];
};

declare global {
  interface Window {
    pa?: Pa;
  }
}
