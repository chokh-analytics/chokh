import { describe, expect, it } from 'vitest';

import { runPresenceConformance } from './conformance/presence.js';
import { createMemoryPresence, presenceEntryOf, snapshotFrom, type PresenceEntry } from './presence.js';
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
      visitors: [],
    });
  });
});
