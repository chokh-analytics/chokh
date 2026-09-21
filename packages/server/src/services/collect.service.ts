import type { ClientHints, GeoReader } from '@chokh/geo';
import { parseUserAgent } from '@chokh/geo';

import { applyIpMode } from '../lib/ip-privacy.js';
import type { WindowCounter } from '../lib/window-counter.js';
import type { Bus } from './bus.js';
import type { CollectBatch, CollectEvent } from '../schemas/collect.schema.js';
import type { AnalyticsStore, Attributes, Site, StoredEvent } from '../store/AnalyticsStore.js';
import { isBot } from './bots.js';
import type { Dedupe } from './dedupe.js';
import { confirmIdentity, type IdentityVerdict } from './identity.js';
import type { VisitorIdSource } from './visitor-id.js';

// An event carries the browser's clock, which can be wrong by anything. It is
// never later than the moment it arrived, and never older than a day, which is
// longer than the tracker's consent buffer can hold one.
const MAX_BACKDATE_MS = 24 * 60 * 60 * 1000;

export function clampTimestamp(ts: number, receivedAt: number): number {
  if (!Number.isFinite(ts) || ts > receivedAt) {
    return receivedAt;
  }
  return ts < receivedAt - MAX_BACKDATE_MS ? receivedAt - MAX_BACKDATE_MS : ts;
}

export interface CollectDeps {
  store: AnalyticsStore;
  geo: GeoReader;
  visitorIds: VisitorIdSource;
  ipLimit: WindowCounter;
  siteLimit: WindowCounter;
  visitorRate: WindowCounter;
  dedupe: Dedupe;
  limits: { perIp: number; perSite: number };
  // Wakes the realtime streams watching this site once the batch has landed.
  // Optional, because the collector is a complete thing without a dashboard
  // attached and a test of ingestion should not have to build a bus.
  bus?: Bus;
  now(): number;
}

export interface CollectInput {
  batch: CollectBatch;
  ip: string;
  userAgent: string;
  origin: string | undefined;
  hints: ClientHints;
}

export type CollectResult =
  | { ok: true; accepted: number; identity: IdentityVerdict['kind'] }
  | { ok: false; status: number; code: string; message: string };

// The Origin of a browser post, or the Referer when a browser sent only that.
export function requestHostname(origin: string | undefined): string | undefined {
  if (origin === undefined || origin === '' || origin === 'null') {
    return undefined;
  }
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function originAllowed(hostname: string | undefined, domains: string[]): boolean {
  return hostname !== undefined && domains.some((domain) => domain.toLowerCase() === hostname);
}

function copy(value: Attributes | undefined): Attributes | undefined {
  return value === undefined || Object.keys(value).length === 0 ? undefined : { ...value };
}

function toStoredEvent(
  event: CollectEvent,
  batch: CollectBatch,
  site: Site,
  context: {
    receivedAt: number;
    visitorId: string;
    // The identity the site was willing to confirm, and nothing the page
    // merely claimed.
    userId: string | undefined;
    bot: boolean;
    ip: string | undefined;
    geo: ReturnType<GeoReader['lookup']>;
    ua: ReturnType<typeof parseUserAgent>;
  },
): StoredEvent {
  const stored: StoredEvent = {
    siteId: site.id,
    ts: clampTimestamp(event.ts, context.receivedAt),
    receivedAt: context.receivedAt,
    type: event.type,
    visitorId: context.visitorId,
    hostname: batch.hostname,
    bot: context.bot,
    ua: context.ua,
    geo: context.geo,
  };

  if (context.ip !== undefined) stored.ip = context.ip;
  if (batch.lang !== undefined) stored.lang = batch.lang;
  if (batch.screen !== undefined) stored.screen = batch.screen;
  if (batch.viewport !== undefined) stored.viewport = batch.viewport;

  if (context.userId !== undefined) stored.userId = context.userId;

  if (event.path !== undefined) stored.path = event.path;
  if (event.title !== undefined) stored.title = event.title;
  if (event.referrer !== undefined) stored.referrer = event.referrer;
  if (event.name !== undefined) stored.name = event.name;
  // Only a pageview answers with a status. A heartbeat or an event carrying
  // one would put a beat in the status report, which is a dimension of what
  // pages answered and nothing else.
  if (event.type === 'pageview' && event.status !== undefined) stored.status = event.status;
  if (event.duration !== undefined) stored.duration = event.duration;
  if (event.scrollDepth !== undefined) stored.scrollDepth = event.scrollDepth;
  if (event.value !== undefined) stored.value = event.value;
  if (event.rating !== undefined) stored.rating = event.rating;

  const utm = copy(event.utm);
  if (utm !== undefined) stored.utm = utm;
  const props = copy(event.props);
  if (props !== undefined) stored.props = props;
  // Traits are a claim about a person, so they only travel with an identity
  // the site confirmed.
  const traits = context.userId === undefined ? undefined : copy(event.traits);
  if (traits !== undefined) stored.traits = traits;

  return stored;
}

export async function collect(deps: CollectDeps, input: CollectInput): Promise<CollectResult> {
  const receivedAt = deps.now();
  const { batch } = input;

  if (deps.ipLimit.hit(input.ip, receivedAt) > deps.limits.perIp) {
    return { ok: false, status: 429, code: 'RATE_LIMITED', message: 'Too many batches from this address' };
  }

  const site = await deps.store.site(batch.siteId);
  if (site === null) {
    return { ok: false, status: 403, code: 'UNKNOWN_SITE', message: 'No site answers to that key' };
  }

  if (deps.siteLimit.hit(site.id, receivedAt) > deps.limits.perSite) {
    return { ok: false, status: 429, code: 'RATE_LIMITED', message: 'Too many batches for this site' };
  }

  if (!originAllowed(requestHostname(input.origin), site.domains)) {
    return { ok: false, status: 403, code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not a domain of this site' };
  }

  // The raw address is what identifies a cookieless visitor and what the geo
  // database is asked about. Only what the site's IP mode allows is stored.
  const visitorId =
    site.settings.visitorIdMode === 'persistent' && batch.visitorId !== undefined
      ? batch.visitorId
      : deps.visitorIds.derive(site.id, input.ip, input.userAgent, receivedAt);

  const eventsInWindow = deps.visitorRate.hit(
    `${site.id}:${visitorId}`,
    receivedAt,
    batch.events.length,
  );
  const bot = site.settings.botFilter
    ? isBot({ userAgent: input.userAgent, eventsInWindow })
    : false;

  const geo = deps.geo.lookup(input.ip);
  const ua = parseUserAgent(input.userAgent, input.hints);
  const ip = applyIpMode(input.ip, site.settings.ipMode);

  // Who the site is willing to say this visitor is. An identify the site will
  // not confirm carries nothing else, so it is dropped rather than stored as a
  // nameless row; everything else in the batch is collected anonymously.
  const identity = confirmIdentity(site, batch);
  const userId = identity.kind === 'confirmed' ? identity.userId : undefined;

  const stored: StoredEvent[] = [];
  for (const event of batch.events) {
    if (event.type === 'identify' && userId === undefined) {
      continue;
    }
    if (
      event.type === 'pageview' &&
      deps.dedupe.seen(`${site.id}:${visitorId}:${event.path ?? ''}`, receivedAt)
    ) {
      continue;
    }
    stored.push(
      toStoredEvent(event, batch, site, { receivedAt, visitorId, userId, bot, ip, geo, ua }),
    );
  }

  if (stored.length > 0) {
    await deps.store.ingest(stored);
    // After the write, never before: a stream woken early would read the presence
    // set as it was and then sit still until the next batch. Crawlers are never in
    // the presence set, so they never wake anybody either.
    if (!bot) {
      await deps.bus?.publish(site.id);
    }
  }
  return { ok: true, accepted: stored.length, identity: identity.kind };
}
