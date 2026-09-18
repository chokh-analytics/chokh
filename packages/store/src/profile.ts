import type { TimelineEntry, VisitorProfile } from './query.js';
import { MAX_VISITOR_DEVICES, MAX_VISITOR_IPS } from './session.js';
import type { Attributes, PlaceTally, StoredEvent, StoredVisitor } from './types.js';

// How a person's rows become a profile. Shared, so the MongoDB answer and the
// in-memory answer describe the same visitor.
//
// The visitor row is what a profile is made of: the counts, the first and last
// sighting, the devices, the addresses, where they usually connect from and
// what first brought them here are all kept there by ingest. Raw events are
// read only for the timeline, and they age out at the site's retention while
// the row does not, so a profile stays answerable after the detail is gone.
// A user lookup spans several visitors, which is why this takes a list.

// How many recent events a timeline is built from.
export const PROFILE_EVENT_LIMIT = 1000;

// How many of them the timeline shows.
export const PROFILE_TIMELINE_LIMIT = 50;

export interface ProfileTotals {
  firstSeenAt: number;
  lastSeenAt: number;
  pageviews: number;
  events: number;
  sessions: number;
}

export type ProfileBody = Omit<VisitorProfile, 'siteId' | 'visitorId'>;

function mergeVisitors(visitors: StoredVisitor[]): StoredVisitor | undefined {
  const ordered = [...visitors].sort((left, right) => left.lastSeenAt - right.lastSeenAt);
  const first = ordered[0];
  if (first === undefined) {
    return undefined;
  }
  const devices: string[] = [];
  const ips: string[] = [];
  const places: PlaceTally[] = [];
  let traits: Attributes | undefined;
  let userId: string | undefined;
  let firstSeenAt = Number.MAX_SAFE_INTEGER;
  let lastSeenAt = 0;
  let sessions = 0;
  let pageviews = 0;
  let firstTouch = first.firstTouch;
  let lastTouch = first.lastTouch;

  for (const visitor of ordered) {
    firstSeenAt = Math.min(firstSeenAt, visitor.firstSeenAt);
    lastSeenAt = Math.max(lastSeenAt, visitor.lastSeenAt);
    sessions += visitor.sessions;
    pageviews += visitor.pageviews;
    if (visitor.userId !== undefined) userId = visitor.userId;
    if (visitor.traits !== undefined) traits = { ...traits, ...visitor.traits };
    for (const device of visitor.devices) {
      if (!devices.includes(device) && devices.length < MAX_VISITOR_DEVICES) devices.push(device);
    }
    for (const ip of visitor.ips) {
      if (!ips.includes(ip) && ips.length < MAX_VISITOR_IPS) ips.push(ip);
    }
    for (const place of visitor.places ?? []) {
      const known = places.find((entry) => entry.key === place.key);
      if (known === undefined) places.push({ ...place });
      else known.count += place.count;
    }
    if (visitor.firstTouch !== undefined) {
      if (firstTouch === undefined || visitor.firstTouch.at < firstTouch.at) {
        firstTouch = visitor.firstTouch;
      }
    }
    if (visitor.lastTouch !== undefined) {
      if (lastTouch === undefined || visitor.lastTouch.at >= lastTouch.at) {
        lastTouch = visitor.lastTouch;
      }
    }
  }

  const merged: StoredVisitor = {
    siteId: first.siteId,
    id: first.id,
    firstSeenAt,
    lastSeenAt,
    sessions,
    pageviews,
    devices,
    ips,
    places,
  };
  if (userId !== undefined) merged.userId = userId;
  if (traits !== undefined) merged.traits = traits;
  if (firstTouch !== undefined) merged.firstTouch = firstTouch;
  if (lastTouch !== undefined) merged.lastTouch = lastTouch;
  const home = places.reduce<PlaceTally | undefined>(
    (best, entry) => (best === undefined || entry.count > best.count ? entry : best),
    undefined,
  );
  if (home !== undefined) merged.homeGeo = home.geo;
  return merged;
}

export function profileFrom(
  // The person's recent events, oldest first.
  ordered: StoredEvent[],
  // Their visitor rows: one for a visitor lookup, several for a user.
  visitors: StoredVisitor[],
  // Counts an adapter can take exactly without loading a history. Used where
  // no visitor row answers, which is only a store seeded straight with events.
  exact?: Partial<ProfileTotals>,
): ProfileBody {
  const row = mergeVisitors(visitors);

  let pageviews = 0;
  let custom = 0;
  let userId = row?.userId;
  let traits = row?.traits;
  const devices = [...(row?.devices ?? [])];
  const ips = [...(row?.ips ?? [])];
  const places = (row?.places ?? []).map((entry) => ({ ...entry }));

  for (const event of ordered) {
    if (event.type === 'pageview') pageviews += 1;
    if (event.type === 'event') custom += 1;
    if (row === undefined) {
      if (event.userId !== undefined) userId = event.userId;
      if (event.traits !== undefined) traits = { ...traits, ...event.traits };
      const device = [event.ua?.browser, event.ua?.os]
        .filter((part) => part !== undefined && part !== '')
        .join(' on ');
      if (device !== '' && !devices.includes(device)) devices.push(device);
      if (event.ip !== undefined && !ips.includes(event.ip)) ips.push(event.ip);
      if (event.geo !== undefined) {
        const key = [event.geo.country, event.geo.region, event.geo.city].join('|');
        const known = places.find((entry) => entry.key === key);
        if (known === undefined) places.push({ key, count: 1, geo: event.geo });
        else known.count += 1;
      }
    }
  }

  const timeline: TimelineEntry[] = [...ordered]
    .reverse()
    .slice(0, PROFILE_TIMELINE_LIMIT)
    .map((event) => {
      const entry: TimelineEntry = { ts: event.ts, type: event.type };
      if (event.path !== undefined) entry.path = event.path;
      if (event.name !== undefined) entry.name = event.name;
      return entry;
    });

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const profile: ProfileBody = {
    firstSeenAt: row?.firstSeenAt ?? exact?.firstSeenAt ?? first?.ts ?? 0,
    lastSeenAt: row?.lastSeenAt ?? exact?.lastSeenAt ?? last?.ts ?? 0,
    pageviews: row?.pageviews ?? exact?.pageviews ?? pageviews,
    // A custom event count is not on the row, so it is the one number an
    // adapter still counts for itself.
    events: exact?.events ?? custom,
    sessions: row?.sessions ?? exact?.sessions ?? 0,
    devices,
    ips,
    timeline,
  };
  if (userId !== undefined) profile.userId = userId;
  if (traits !== undefined) profile.traits = traits;
  const home = places.reduce<PlaceTally | undefined>(
    (best, entry) => (best === undefined || entry.count > best.count ? entry : best),
    undefined,
  );
  if (home !== undefined) profile.homeGeo = home.geo;
  if (row?.firstTouch !== undefined) profile.firstTouch = row.firstTouch;
  if (row?.lastTouch !== undefined) profile.lastTouch = row.lastTouch;
  return profile;
}
