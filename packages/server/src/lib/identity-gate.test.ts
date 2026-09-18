import { describe, expect, it } from 'vitest';

import { gateRealtime, gateVisitorProfile, identityFieldsOfUser } from './identity-gate.js';
import type { RealtimeSnapshot, UserProfile, VisitorProfile } from '../store/AnalyticsStore.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

function snapshot(): RealtimeSnapshot {
  return {
    online: 2,
    signedIn: 1,
    anonymous: 1,
    byPage: [{ key: '/pricing', visitors: 2 }],
    byCountry: [{ key: 'BD', visitors: 2 }],
    visitors: [
      {
        visitorId: 'v_1',
        userId: 'u_42',
        path: '/pricing',
        country: 'BD',
        city: 'Dhaka',
        browser: 'Chrome',
        os: 'Windows',
        device: 'desktop',
        ip: '203.0.113.7',
        since: NOW - 60_000,
        lastSeenAt: NOW,
      },
      {
        visitorId: 'v_2',
        path: '/pricing',
        country: 'BD',
        since: NOW - 30_000,
        lastSeenAt: NOW,
      },
    ],
  };
}

function profile(): VisitorProfile {
  return {
    siteId: 's_one',
    visitorId: 'v_1',
    userId: 'u_42',
    traits: { plan: 'pro' },
    firstSeenAt: NOW - 86_400_000,
    lastSeenAt: NOW,
    pageviews: 12,
    events: 3,
    sessions: 2,
    devices: ['Chrome on Windows'],
    ips: ['203.0.113.7'],
    timeline: [],
  };
}

describe('gateRealtime', () => {
  it('keeps the whole list for a caller with read:identity and names what it revealed', () => {
    const gated = gateRealtime(snapshot(), true);
    expect(gated.value.visitors[0]?.ip).toBe('203.0.113.7');
    expect(gated.value.visitors[0]?.userId).toBe('u_42');
    expect(gated.fields).toEqual(['ip', 'userId']);
  });

  // The dashboard's Realtime page hides the IP column and shows the list. The page,
  // the country, the city and the device are traffic; the address and the name are
  // not.
  it('strips the address and the name without it, and keeps everything else', () => {
    const gated = gateRealtime(snapshot(), false);
    const [first, second] = gated.value.visitors;
    expect(first).not.toHaveProperty('ip');
    expect(first).not.toHaveProperty('userId');
    expect(first?.path).toBe('/pricing');
    expect(first?.city).toBe('Dhaka');
    expect(first?.device).toBe('desktop');
    expect(second?.visitorId).toBe('v_2');
    expect(gated.fields).toEqual([]);
  });

  // "Seventeen people are here, four of them signed in" names nobody.
  it('never gates the counts', () => {
    const gated = gateRealtime(snapshot(), false);
    expect(gated.value.online).toBe(2);
    expect(gated.value.signedIn).toBe(1);
    expect(gated.value.anonymous).toBe(1);
    expect(gated.value.byPage).toEqual([{ key: '/pricing', visitors: 2 }]);
  });

  // A read that revealed nothing personal writes no audit row, and this is how the
  // caller knows: the field list is empty even with the scope.
  it('names no field when the answer happened to carry nothing personal', () => {
    const anonymous: RealtimeSnapshot = {
      ...snapshot(),
      visitors: [{ visitorId: 'v_2', path: '/', since: NOW, lastSeenAt: NOW }],
    };
    expect(gateRealtime(anonymous, true).fields).toEqual([]);
  });
});

describe('gateVisitorProfile', () => {
  it('keeps the addresses, the name and the traits with the scope', () => {
    const gated = gateVisitorProfile(profile(), true);
    expect(gated.value.ips).toEqual(['203.0.113.7']);
    expect(gated.value.userId).toBe('u_42');
    expect(gated.value.traits).toEqual({ plan: 'pro' });
    expect(gated.fields).toEqual(['ips', 'traits', 'userId']);
  });

  it('empties the addresses and drops the name and traits without it', () => {
    const gated = gateVisitorProfile(profile(), false);
    expect(gated.value.ips).toEqual([]);
    expect(gated.value).not.toHaveProperty('userId');
    expect(gated.value).not.toHaveProperty('traits');
    // The rest of the profile is traffic and stays.
    expect(gated.value.pageviews).toBe(12);
    expect(gated.value.devices).toEqual(['Chrome on Windows']);
    expect(gated.fields).toEqual([]);
  });
});

describe('identityFieldsOfUser', () => {
  // Reaching the route means naming the person, so userId is always revealed.
  it('always names userId, and the others when they are there', () => {
    const user: UserProfile = { ...profile(), userId: 'u_42', visitorIds: ['v_1'] };
    expect(identityFieldsOfUser(user)).toEqual(['ips', 'traits', 'userId']);
    const plain: UserProfile = { ...user, ips: [] };
    delete plain.traits;
    expect(identityFieldsOfUser(plain)).toEqual(['userId']);
  });
});
