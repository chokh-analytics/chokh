import { createHash } from 'node:crypto';

import { classifyChannel, type Channel } from './channel.js';
import type {
  Attributes,
  PlaceTally,
  StoredEvent,
  StoredSession,
  StoredVisitor,
  Touch,
} from './types.js';

// How a stream of events becomes sessions, visitors and identity. The fold is
// here rather than in an adapter for the same reason the read plan is: two
// adapters that each invented a gap rule would file the same stay under two
// different numbers, and the conformance suite could never catch it, because it
// asks both of them the same question.

// A visitor's events with no gap this long are one stay. Thirty minutes is what
// every analytics product has meant by a session since the first one, and a
// site owner comparing Chokh to what they used before is comparing this.
export const SESSION_GAP_MS = 30 * 60 * 1000;

// A row carries a person's history, so the lists on it are capped: a visitor
// who roams should not grow their own row without bound.
export const MAX_VISITOR_DEVICES = 20;
export const MAX_VISITOR_IPS = 50;
export const MAX_VISITOR_PLACES = 24;

// Deterministic from the stay it names, so the same batch ingested twice lands
// on the same row instead of a second session.
export function sessionIdFor(siteId: string, visitorId: string, startedAt: number): string {
  return createHash('sha256')
    .update(`${siteId}\n${visitorId}\n${startedAt}`)
    .digest('base64url')
    .slice(0, 22);
}

// One page and away. A session with no pageview at all (a server side event, an
// identify on its own) bounced too: nothing was read.
export function isBounce(session: StoredSession): boolean {
  return session.pageviews <= 1;
}

export interface VisitorFold {
  siteId: string;
  visitorId: string;
  // This visitor's events out of the batch, in any order.
  events: StoredEvent[];
  // Their latest session, or null when they have never been here.
  open: StoredSession | null;
  visitor: StoredVisitor | null;
}

export interface VisitorFoldResult {
  // The same events, copied, with sessionId and the resolved identity stamped.
  events: StoredEvent[];
  // Sessions to upsert: the open one when it grew, plus any that began here.
  sessions: StoredSession[];
  visitor: StoredVisitor;
  // Set when a confirmed identity reached this visitor for the first time.
  // Every session and event of theirs written before now takes this userId,
  // which is what "identify merges the anonymous sessions before it" means.
  merge?: string;
}

function placeOf(session: StoredSession): PlaceTally | undefined {
  if (session.geo === undefined) {
    return undefined;
  }
  const key = [session.geo.country, session.geo.region, session.geo.city].join('|');
  return { key, count: 1, geo: session.geo };
}

function touchOf(session: StoredSession): Touch {
  const touch: Touch = { at: session.startedAt, channel: (session.channel ?? 'direct') as Channel };
  if (session.referrer !== undefined) touch.referrer = session.referrer;
  if (session.utm !== undefined) touch.utm = { ...session.utm };
  if (session.entryPath !== undefined) touch.entryPath = session.entryPath;
  return touch;
}

function push(list: string[], value: string | undefined, cap: number): void {
  if (value === undefined || value === '' || list.includes(value)) {
    return;
  }
  if (list.length < cap) {
    list.push(value);
  }
}

export function foldVisitor(input: VisitorFold): VisitorFoldResult {
  const { siteId, visitorId } = input;
  const ordered = input.events
    .map((event) => ({ ...event }))
    .sort((left, right) => left.ts - right.ts);

  // The collector has already decided whether to believe an identity, so a
  // userId that reaches the store is confirmed. A batch that claims nothing
  // still belongs to whoever this visitor is known to be: the tracker forgets
  // the userId on a reload, the visitor id survives it, and pa('reset') is the
  // one way a browser says the person at the keyboard changed.
  const claimed = ordered.find((event) => event.userId !== undefined)?.userId;
  const previous = input.visitor?.userId;
  const userId = claimed ?? previous;
  // A visitor who already answers to somebody else keeps their old sessions
  // under the old name. One person does not inherit another's history because
  // they shared a computer.
  const merge = claimed !== undefined && previous === undefined ? claimed : undefined;

  let current: StoredSession | null = input.open === null ? null : { ...input.open };
  const touched = new Map<string, StoredSession>();
  const created: StoredSession[] = [];
  let pageviews = 0;
  let traits: Attributes | undefined = input.visitor?.traits;

  for (const event of ordered) {
    if (current === null || Math.abs(event.ts - current.lastSeenAt) >= SESSION_GAP_MS) {
      current = {
        siteId,
        id: sessionIdFor(siteId, visitorId, event.ts),
        visitorId,
        startedAt: event.ts,
        lastSeenAt: event.ts,
        pageviews: 0,
        events: 0,
        duration: 0,
        // A session is a crawler's when the event that opened it was tagged
        // one. An event keeps its own flag, so a visitor the rate heuristic
        // tags halfway through changes the event counts before the visit ones.
        bot: event.bot,
        isNew: input.visitor === null && created.length === 0,
      };
      created.push(current);
    }

    const wasStart = current.startedAt;
    const wasLast = current.lastSeenAt;
    if (event.ts < current.startedAt) current.startedAt = event.ts;
    if (event.ts > current.lastSeenAt) current.lastSeenAt = event.ts;
    current.duration = current.lastSeenAt - current.startedAt;

    if (event.type === 'pageview') {
      current.pageviews += 1;
      pageviews += 1;
    }
    if (event.type === 'event') current.events += 1;
    if (event.type === 'leave') {
      current.endedAt = Math.max(current.endedAt ?? 0, event.ts);
    }
    if (event.path !== undefined) {
      if (current.entryPath === undefined || event.ts <= wasStart) current.entryPath = event.path;
      if (current.exitPath === undefined || event.ts >= wasLast) current.exitPath = event.path;
    }
    // Where the stay came from is a fact about its first event: a referrer only
    // reaches the tracker on the first pageview of a page load, and a campaign
    // is the link that was clicked, not the page that was read last.
    if (event.ts <= wasStart || current.channel === undefined) {
      if (event.referrer !== undefined) current.referrer = event.referrer;
      if (event.utm !== undefined) current.utm = { ...event.utm };
      if (event.geo !== undefined) current.geo = { ...event.geo };
      if (event.ua !== undefined) current.ua = { ...event.ua };
      if (event.ip !== undefined) current.ip = event.ip;
      current.channel = classifyChannel({
        ...(event.referrer === undefined ? {} : { referrer: event.referrer }),
        ...(event.utm === undefined ? {} : { utm: event.utm }),
        ...(event.hostname === undefined ? {} : { hostname: event.hostname }),
      });
    }
    if (event.traits !== undefined) {
      traits = { ...traits, ...event.traits };
    }
    if (userId !== undefined) current.userId = userId;

    event.sessionId = current.id;
    if (userId !== undefined) event.userId = userId;
    touched.set(current.id, current);
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const devices = [...(input.visitor?.devices ?? [])];
  const ips = [...(input.visitor?.ips ?? [])];
  const places = (input.visitor?.places ?? []).map((entry) => ({ ...entry }));

  for (const session of created) {
    const device = [session.ua?.browser, session.ua?.os]
      .filter((part) => part !== undefined && part !== '')
      .join(' on ');
    push(devices, device === '' ? undefined : device, MAX_VISITOR_DEVICES);
    push(ips, session.ip, MAX_VISITOR_IPS);
    const seen = placeOf(session);
    if (seen !== undefined) {
      const existing = places.find((entry) => entry.key === seen.key);
      if (existing !== undefined) {
        existing.count += 1;
      } else if (places.length < MAX_VISITOR_PLACES) {
        places.push(seen);
      }
    }
  }

  const visitor: StoredVisitor = {
    siteId,
    id: visitorId,
    firstSeenAt: Math.min(input.visitor?.firstSeenAt ?? Number.MAX_SAFE_INTEGER, first?.ts ?? 0),
    lastSeenAt: Math.max(input.visitor?.lastSeenAt ?? 0, last?.ts ?? 0),
    sessions: (input.visitor?.sessions ?? 0) + created.length,
    pageviews: (input.visitor?.pageviews ?? 0) + pageviews,
    devices,
    ips,
    places,
  };
  if (userId !== undefined) visitor.userId = userId;
  if (traits !== undefined) visitor.traits = traits;

  // Where they usually connect from: the place most of their sessions opened
  // in, so one trip abroad does not move a person's home.
  const home = places.reduce<PlaceTally | undefined>(
    (best, entry) => (best === undefined || entry.count > best.count ? entry : best),
    undefined,
  );
  if (home !== undefined) visitor.homeGeo = home.geo;

  // First touch is written once and never again; last touch is the newest stay
  // that began, so attribution reads the same from either end.
  const opened = created[0];
  const firstTouch = input.visitor?.firstTouch ?? (opened === undefined ? undefined : touchOf(opened));
  const newest = created[created.length - 1];
  const lastTouch = newest === undefined ? input.visitor?.lastTouch : touchOf(newest);
  if (firstTouch !== undefined) visitor.firstTouch = firstTouch;
  if (lastTouch !== undefined) visitor.lastTouch = lastTouch;

  const result: VisitorFoldResult = {
    events: ordered,
    sessions: [...touched.values()],
    visitor,
  };
  if (merge !== undefined) result.merge = merge;
  return result;
}

// Group a batch the way the fold wants it: one entry per site and visitor.
export function groupForFold(events: StoredEvent[]): Map<string, StoredEvent[]> {
  const groups = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const key = `${event.siteId}\n${event.visitorId}`;
    const list = groups.get(key);
    if (list === undefined) {
      groups.set(key, [event]);
    } else {
      list.push(event);
    }
  }
  return groups;
}
