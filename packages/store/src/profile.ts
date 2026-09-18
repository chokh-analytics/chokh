import type { TimelineEntry, VisitorProfile } from './query.js';
import type { StoredEvent } from './types.js';

// How a person's events become a profile. Shared, so the MongoDB answer and
// the in-memory answer describe the same visitor.
//
// This reads raw events because AN-STO01 declares the visitors collection but
// does not write it. When AN-SES01 fills that collection, firstSeenAt,
// lastSeenAt, the counts and the device and address lists come from one row
// and this reducer keeps only the timeline.

// How many recent events a profile is built from. The timeline shows the last
// of them and the lists are what those events saw; the counts and the first
// and last sighting are exact, because an adapter that can count without
// loading passes them in.
export const PROFILE_EVENT_LIMIT = 1000;

export interface ProfileTotals {
  firstSeenAt: number;
  lastSeenAt: number;
  pageviews: number;
  events: number;
  sessions: number;
}

export type ProfileBody = Omit<VisitorProfile, 'siteId' | 'visitorId'>;

export function profileFromEvents(
  ordered: StoredEvent[],
  totals?: Partial<ProfileTotals>,
): ProfileBody {
  const devices: string[] = [];
  const ips: string[] = [];
  const places = new Map<string, { count: number; geo: StoredEvent['geo'] }>();
  let userId: string | undefined;
  let traits: StoredEvent['traits'];
  let pageviews = 0;
  let custom = 0;

  for (const event of ordered) {
    if (event.type === 'pageview') pageviews += 1;
    if (event.type === 'event') custom += 1;
    if (event.userId !== undefined) userId = event.userId;
    if (event.traits !== undefined) traits = { ...traits, ...event.traits };
    const device = [event.ua?.browser, event.ua?.os]
      .filter((part) => part !== undefined && part !== '')
      .join(' on ');
    if (device !== '' && !devices.includes(device)) devices.push(device);
    if (event.ip !== undefined && !ips.includes(event.ip)) ips.push(event.ip);
    if (event.geo !== undefined) {
      const key = [event.geo.country, event.geo.region, event.geo.city].join('|');
      const place = places.get(key);
      if (place === undefined) {
        places.set(key, { count: 1, geo: event.geo });
      } else {
        place.count += 1;
      }
    }
  }

  let homeGeo: StoredEvent['geo'];
  let best = 0;
  for (const place of places.values()) {
    if (place.count > best) {
      best = place.count;
      homeGeo = place.geo;
    }
  }

  const timeline: TimelineEntry[] = [...ordered]
    .reverse()
    .slice(0, 50)
    .map((event) => {
      const entry: TimelineEntry = { ts: event.ts, type: event.type };
      if (event.path !== undefined) entry.path = event.path;
      if (event.name !== undefined) entry.name = event.name;
      return entry;
    });

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const profile: ProfileBody = {
    firstSeenAt: totals?.firstSeenAt ?? first?.ts ?? 0,
    lastSeenAt: totals?.lastSeenAt ?? last?.ts ?? 0,
    pageviews: totals?.pageviews ?? pageviews,
    events: totals?.events ?? custom,
    sessions: totals?.sessions ?? 0,
    devices,
    ips,
    timeline,
  };
  if (userId !== undefined) profile.userId = userId;
  if (traits !== undefined) profile.traits = traits;
  if (homeGeo !== undefined) profile.homeGeo = homeGeo;
  return profile;
}
