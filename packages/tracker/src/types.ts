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
  // What the page says it answered, on a pageview and nowhere else.
  status?: string;
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
  // The site's proof that it, and not this page, said who the visitor is: the
  // fourth argument of pa('identify'). Sent on every batch after it, because
  // the userId is on every batch after it too.
  sig?: string;
  events: TrackedEvent[];
}

export interface Context {
  visitorId?: string;
  userId?: string;
  sig?: string;
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
    // The one value a page hands this script rather than calling it with: a
    // browser cannot read the response code its own page came back with, so a
    // not-found page declares it. Read by the pageview that follows and then
    // cleared.
    paStatus?: string | number;
  }
}
