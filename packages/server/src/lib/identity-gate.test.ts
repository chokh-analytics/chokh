import { describe, expect, it } from 'vitest';

import {
  gateAuditPage,
  gateRealtime,
  gateVisitorProfile,
  identityFieldsOfUser,
} from './identity-gate.js';
import type {
  AuditEntry,
  PersonRow,
  RealtimeSnapshot,
  UserProfile,
  VisitorProfile,
} from '../store/AnalyticsStore.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

function snapshot(): RealtimeSnapshot {
  return {
    online: 2,
    signedIn: 1,
    anonymous: 1,
    byPage: [{ key: '/pricing', visitors: 2 }],
    byCountry: [{ key: 'BD', visitors: 2 }],
    byCity: [{ key: 'Dhaka', visitors: 2, country: 'BD', lat: 23.81, lon: 90.41 }],
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
    recent: [
      {
        visitorId: 'v_3',
        userId: 'u_99',
        path: '/docs',
        country: 'BD',
        ip: '203.0.113.9',
        since: NOW - 900_000,
        lastSeenAt: NOW - 300_000,
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
      recent: [],
    };
    expect(gateRealtime(anonymous, true).fields).toEqual([]);
  });

  // The second list is the same people a few minutes earlier. A strip that only
  // covered the first one would be the gate undone by the list nobody checked.
  it('strips the recent list too, and counts what it revealed', () => {
    const open = gateRealtime(snapshot(), true);
    expect(open.value.recent[0]?.ip).toBe('203.0.113.9');
    expect(open.value.recent[0]?.userId).toBe('u_99');

    const closed = gateRealtime(snapshot(), false);
    expect(closed.value.recent[0]).not.toHaveProperty('ip');
    expect(closed.value.recent[0]).not.toHaveProperty('userId');
    expect(closed.value.recent[0]?.path).toBe('/docs');
    expect(closed.fields).toEqual([]);
  });

  // A city centre rounded to two decimals is a place, not a person, which is why
  // it is beside the country rather than behind the scope.
  it('never gates the city tally or its coordinates', () => {
    const gated = gateRealtime(snapshot(), false);
    expect(gated.value.byCity).toEqual([
      { key: 'Dhaka', visitors: 2, country: 'BD', lat: 23.81, lon: 90.41 },
    ]);
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

// A row of the people directory is the same visitor row, so it goes through the
// same strip: the rule is written once and both reads use it.
describe('gateVisitorProfile on a directory row', () => {
  const row: PersonRow = {
    visitorId: 'v_1',
    userId: 'u_42',
    traits: { plan: 'pro' },
    firstSeenAt: NOW - 60_000,
    lastSeenAt: NOW,
    sessions: 1,
    pageviews: 2,
    devices: ['Chrome on Windows'],
    ips: ['203.0.113.7'],
  };

  it('keeps the row whole and lists its fields for a caller with the scope', () => {
    const gated = gateVisitorProfile(row, true);
    expect(gated.value).toEqual(row);
    expect(gated.fields).toEqual(['ips', 'traits', 'userId']);
  });

  it('strips the name, the traits and the addresses for one without', () => {
    const gated = gateVisitorProfile(row, false);
    expect('userId' in gated.value).toBe(false);
    expect('traits' in gated.value).toBe(false);
    expect(gated.value.ips).toEqual([]);
    expect(gated.value.devices).toEqual(['Chrome on Windows']);
    expect(gated.fields).toEqual([]);
  });
});

describe('gateAuditPage', () => {
  const rows: AuditEntry[] = [
    {
      id: '2',
      siteId: 's_test',
      ts: NOW,
      actor: { kind: 'session', id: 'u_1', email: 'owner@test.example' },
      action: 'invite:create',
      route: 'POST /api/sites/:siteId/invitations',
      target: 'ada@test.example',
      fields: ['invitation inv_1', 'role: viewer'],
    },
    {
      id: '1',
      siteId: 's_test',
      ts: NOW - 1000,
      actor: { kind: 'key', id: 'k_1' },
      action: 'read:identity',
      route: 'GET /api/sites/:siteId/visitors/:visitorId',
      target: 'v_1',
      fields: ['ips'],
    },
  ];
  const accounts = { u_1: { email: 'owner@test.example', name: 'Owner' } };

  // An id this install made says nothing about anybody; one another
  // application chose may.
  const standIn = (id: string): string => (id.startsWith('sso_') ? 'sso~stand-in' : id);

  it('leaves the page whole for a caller who may see it, and says what it carried', () => {
    const gated = gateAuditPage({ rows, accounts }, true, standIn);
    expect(gated.value).toEqual({ rows, accounts });
    expect(gated.fields).toEqual(['email', 'name', 'target']);
  });

  it('says only what was there: a page of rows about nobody carried nothing', () => {
    const bare = rows.map(({ target: _target, ...row }) => ({
      ...row,
      actor: { kind: row.actor.kind, id: row.actor.id },
    }));
    expect(gateAuditPage({ rows: bare, accounts: {} }, true, standIn).fields).toEqual([]);
  });

  it('takes out every target, every address and every account without the scope', () => {
    const gated = gateAuditPage({ rows, accounts }, false, standIn);
    expect(gated.fields).toEqual([]);
    expect(gated.value.accounts).toEqual({});
    expect(gated.value.rows).toEqual([
      {
        id: '2',
        siteId: 's_test',
        ts: NOW,
        actor: { kind: 'session', id: 'u_1' },
        action: 'invite:create',
        route: 'POST /api/sites/:siteId/invitations',
        fields: ['invitation inv_1', 'role: viewer'],
      },
      {
        id: '1',
        siteId: 's_test',
        ts: NOW - 1000,
        actor: { kind: 'key', id: 'k_1' },
        action: 'read:identity',
        route: 'GET /api/sites/:siteId/visitors/:visitorId',
        fields: ['ips'],
      },
    ]);
    // The rows it was given are not changed under the caller.
    expect(rows[0]?.target).toBe('ada@test.example');
  });

  it('puts a stand-in where the id of whoever acted is another application name for them', () => {
    const managed: AuditEntry = {
      id: '3',
      siteId: 's_test',
      ts: NOW,
      actor: { kind: 'session', id: 'sso_ada@corp.example', email: 'ada@corp.example' },
      action: 'read:identity',
      route: 'GET /api/sites/:siteId/visitors/:visitorId',
      target: 'v_1',
      fields: ['ips'],
    };
    const hidden = gateAuditPage({ rows: [managed, ...rows], accounts }, false, standIn);
    expect(hidden.value.rows.map((row) => row.actor)).toEqual([
      { kind: 'session', id: 'sso~stand-in' },
      { kind: 'session', id: 'u_1' },
      { kind: 'key', id: 'k_1' },
    ]);
    expect(JSON.stringify(hidden.value)).not.toContain('corp.example');
    // A caller who may see it sees the id as it is.
    expect(gateAuditPage({ rows: [managed], accounts }, true, standIn).value.rows[0]?.actor.id).toBe(
      'sso_ada@corp.example',
    );
  });
});
