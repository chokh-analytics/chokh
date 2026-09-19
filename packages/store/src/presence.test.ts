import { describe, expect, it } from 'vitest';

import { runPresenceConformance } from './conformance/presence.js';
import {
  createMemoryPresence,
  presenceEntryOf,
  snapshotFrom,
  type PresenceEntry,
} from './presence.js';
import { roundCoordinate } from './query.js';
import type { StoredSession } from './types.js';

const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);

// The map is a presence backend, so it passes the presence suite. The Redis
// one passes the same suite in the server package.
runPresenceConformance('memory', () => {
  const presence = createMemoryPresence();
  return Promise.resolve({
    presence,
    reset: () => {
      presence.clear();
      return Promise.resolve();
    },
    close: () => presence.close(),
  });
});

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    siteId: 'site_1',
    id: 's1',
    visitorId: 'v1',
    startedAt: NOW - 600_000,
    lastSeenAt: NOW - 10_000,
    pageviews: 2,
    events: 0,
    duration: 590_000,
    entryPath: '/home',
    exitPath: '/pricing',
    geo: { country: 'BD', city: 'Dhaka' },
    ua: { browser: 'Chrome', os: 'Android', device: 'mobile' },
    ip: '103.87.12.9',
    bot: false,
    isNew: true,
    ...over,
  };
}

describe('presenceEntryOf', () => {
  it('describes a live visitor by the page the stay has got to', () => {
    const entry = presenceEntryOf(session());
    expect(entry).toMatchObject({
      visitorId: 'v1',
      sessionId: 's1',
      since: NOW - 600_000,
      lastSeenAt: NOW - 10_000,
      // Where they are now, not where they came in.
      path: '/pricing',
      country: 'BD',
      city: 'Dhaka',
      browser: 'Chrome',
      device: 'mobile',
    });
  });

  it('never puts a crawler in the set', () => {
    expect(presenceEntryOf(session({ bot: true }))).toBeNull();
  });

  // The coordinates sit outside the identity gate, and this is the whole reason
  // they may: what is kept is the city to about a kilometre, so there is no
  // finer number in the set for anybody to read later.
  it('rounds a coordinate to two decimals on the way in', () => {
    const entry = presenceEntryOf(
      session({ geo: { country: 'IN', city: 'Kolkata', lat: 22.5726459, lon: 88.36389 } }),
    );
    expect(entry?.lat).toBe(22.57);
    expect(entry?.lon).toBe(88.36);
  });

  it('carries no coordinate at all when the geo database had none', () => {
    const entry = presenceEntryOf(session({ geo: { country: 'BD', city: 'Chattogram' } }));
    expect(entry).not.toHaveProperty('lat');
    expect(entry).not.toHaveProperty('lon');
  });

  // The guard behind the sentence above: no entry this function can build
  // carries more precision than the rule allows, whatever the database said.
  it('leaves no entry with more precision than the rule', () => {
    const samples = [
      { lat: 23.8103456, lon: 90.4125123 },
      { lat: -33.86882, lon: 151.20929 },
      { lat: 0.000049, lon: -0.000049 },
      { lat: 51.5, lon: -0.1 },
    ];
    for (const geo of samples) {
      const entry = presenceEntryOf(session({ geo: { country: 'ZZ', city: 'X', ...geo } }));
      expect(entry?.lat).toBe(roundCoordinate(geo.lat));
      expect(entry?.lon).toBe(roundCoordinate(geo.lon));
      for (const value of [entry?.lat ?? 0, entry?.lon ?? 0]) {
        // Written through toFixed rather than a multiply, because 22.57 times a
        // hundred is not 2257 in binary floating point and the assertion would
        // be about that rather than about the rounding.
        expect(Number(value.toFixed(2))).toBe(value);
      }
    }
  });
});

describe('snapshotFrom', () => {
  const entries: PresenceEntry[] = [
    {
      visitorId: 'v1',
      sessionId: 's1',
      since: NOW - 600_000,
      lastSeenAt: NOW - 10_000,
      path: '/pricing',
      country: 'BD',
      userId: 'u_rafi',
    },
    {
      visitorId: 'v2',
      sessionId: 's2',
      since: NOW - 120_000,
      lastSeenAt: NOW - 40_000,
      path: '/pricing',
      country: 'IN',
    },
    {
      visitorId: 'v3',
      sessionId: 's3',
      since: NOW - 900_000,
      lastSeenAt: NOW - 120_000,
      path: '/docs',
      country: 'BD',
    },
  ];

  it('counts only the last minute as online', () => {
    const snapshot = snapshotFrom(entries, NOW);
    expect(snapshot.online).toBe(2);
    expect(snapshot.signedIn).toBe(1);
    expect(snapshot.anonymous).toBe(1);
    expect(snapshot.visitors.map((visitor) => visitor.visitorId)).toEqual(['v1', 'v2']);
  });

  it('tallies the pages and the countries they are on', () => {
    const snapshot = snapshotFrom(entries, NOW);
    expect(snapshot.byPage).toEqual([{ key: '/pricing', visitors: 2 }]);
    expect(snapshot.byCountry).toEqual([
      { key: 'BD', visitors: 1 },
      { key: 'IN', visitors: 1 },
    ]);
  });

  it('puts the most recently seen first', () => {
    const snapshot = snapshotFrom(entries, NOW);
    expect(snapshot.visitors[0]?.visitorId).toBe('v1');
  });

  it('answers empty when nobody is here', () => {
    const snapshot = snapshotFrom([], NOW);
    expect(snapshot).toEqual({
      online: 0,
      signedIn: 0,
      anonymous: 0,
      byPage: [],
      byCountry: [],
      byCity: [],
      visitors: [],
      recent: [],
    });
  });

  // A quiet hour is not a broken page: the people who were here a few minutes
  // ago are kept beside the ones who are here now, and counted in neither.
  it('keeps the rest of the half hour beside the online list', () => {
    const snapshot = snapshotFrom(entries, NOW);
    expect(snapshot.recent.map((visitor) => visitor.visitorId)).toEqual(['v3']);
    expect(snapshot.online).toBe(2);
    expect(snapshot.byPage).not.toContainEqual({ key: '/docs', visitors: 1 });
  });

  it('drops anybody older than the presence window', () => {
    const stale: PresenceEntry = {
      visitorId: 'v4',
      sessionId: 's4',
      since: NOW - 3_600_000,
      lastSeenAt: NOW - 1_900_000,
      path: '/old',
    };
    const snapshot = snapshotFrom([...entries, stale], NOW);
    expect(snapshot.recent.map((visitor) => visitor.visitorId)).toEqual(['v3']);
  });

  // Two places that share a name are two dots, and each dot knows where it is.
  it('tallies the cities with where to draw them', () => {
    const withCities = entries.map((entry, index) =>
      index === 0
        ? { ...entry, city: 'Dhaka', lat: 23.81, lon: 90.41 }
        : index === 1
          ? { ...entry, city: 'Kolkata', lat: 22.57, lon: 88.36 }
          : entry,
    );
    expect(snapshotFrom(withCities, NOW).byCity).toEqual([
      { key: 'Dhaka', visitors: 1, country: 'BD', lat: 23.81, lon: 90.41 },
      { key: 'Kolkata', visitors: 1, country: 'IN', lat: 22.57, lon: 88.36 },
    ]);
  });

  it('never merges two cities that share a name in two countries', () => {
    const twins: PresenceEntry[] = [
      { visitorId: 'a', sessionId: 'sa', since: NOW, lastSeenAt: NOW, city: 'Springfield', country: 'US' },
      { visitorId: 'b', sessionId: 'sb', since: NOW, lastSeenAt: NOW, city: 'Springfield', country: 'CA' },
    ];
    const rows = snapshotFrom(twins, NOW).byCity;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.country).sort()).toEqual(['CA', 'US']);
  });
});
