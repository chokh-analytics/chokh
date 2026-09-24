import type { AnalyticsStore, Attributes, Site, StoredEvent } from '../store/AnalyticsStore.js';
import { clampTimestamp } from './collect.service.js';
import { compileExclusions } from './exclusions.js';

// Events an application sends from its own server, through a key with the
// write:events scope. An order that was paid, a signup that completed, an
// identify for a browser that blocks the tracker: facts a backend knows and a
// page either cannot see or cannot be trusted about.
//
// Four rules make this different from POST /api/collect, and all four are here
// rather than in the route so a test can read them in one place.
//
// 1. The identity is trusted. A key presented by a server is the proof that the
//    browser signature exists to provide, so the userId needs no HMAC and is
//    required: an event with nobody attached has nothing to join to.
// 2. It is never a pageview. A backend did not read a page, and counting one
//    would put views in a report that no visitor performed.
// 3. It never touches presence. A receipt written by a backend is not a sign that
//    somebody is at a keyboard, so the fold leaves these out of the live set
//    (StoredEvent.source is what tells it, see session.ts).
// 4. It carries no address. The stay it joins already has the visitor's geo from
//    the browser, and a backend guessing at an address is how a country report
//    ends up showing a data centre.

export type ServerEventType = 'event' | 'identify';

export interface ServerEventInput {
  type: ServerEventType;
  // Required for an event, meaningless for an identify.
  name?: string;
  ts?: number;
  path?: string;
  props?: Attributes;
  traits?: Attributes;
  value?: number;
}

export interface ServerBatch {
  userId: string;
  // The browser's visitor id when the application knows it, which is the best
  // case: the event lands on the stay the person is in the middle of.
  visitorId?: string;
  events: ServerEventInput[];
}

export interface ServerEventsDeps {
  store: AnalyticsStore;
  now(): number;
}

// Which visitor a server event belongs to, in order of how much it is worth.
//
// The id the application passed is best: it is the same browser, so the event
// joins the stay in progress. Failing that, the visitor this person was last seen
// as, which is right whenever they have ever been here in a browser. Failing
// that, a synthetic id derived from the userId, so a person who only ever exists
// server side is still one visitor and not a new one per event.
export function syntheticVisitorId(userId: string): string {
  return `u:${userId}`;
}

export async function resolveVisitorId(
  deps: ServerEventsDeps,
  siteId: string,
  batch: ServerBatch,
): Promise<string> {
  if (batch.visitorId !== undefined && batch.visitorId !== '') {
    return batch.visitorId;
  }
  const known = await deps.store.visitorIdForUser(siteId, batch.userId);
  return known ?? syntheticVisitorId(batch.userId);
}

export interface ServerEventsResult {
  accepted: number;
  visitorId: string;
}

export async function sendServerEvents(
  deps: ServerEventsDeps,
  site: Site,
  batch: ServerBatch,
): Promise<ServerEventsResult> {
  const receivedAt = deps.now();
  const visitorId = await resolveVisitorId(deps, site.id, batch);

  // The site's path exclusions apply to what a backend sends too; there is no
  // address to exclude by, a server having none.
  const excluded = compileExclusions(site.settings);
  const kept = batch.events.filter((event) => {
    const path = event.path === undefined ? undefined : excluded.strip(event.path);
    return !excluded.path(path);
  });

  const stored: StoredEvent[] = kept.map((event) => {
    const row: StoredEvent = {
      siteId: site.id,
      ts: clampTimestamp(event.ts ?? receivedAt, receivedAt),
      receivedAt,
      type: event.type,
      visitorId,
      userId: batch.userId,
      // A server is not a crawler and is never rate-heuristic tagged as one.
      bot: false,
      source: 'server',
    };
    if (event.name !== undefined) row.name = event.name;
    if (event.path !== undefined) row.path = excluded.strip(event.path);
    if (event.props !== undefined) row.props = { ...event.props };
    if (event.traits !== undefined) row.traits = { ...event.traits };
    if (event.value !== undefined) row.value = event.value;
    return row;
  });

  if (stored.length > 0) {
    await deps.store.ingest(stored);
  }
  return { accepted: stored.length, visitorId };
}
