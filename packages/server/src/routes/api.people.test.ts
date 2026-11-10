import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  NOW,
  SITE_ID,
  type Harness,
} from './api.test-utils.js';
import type {
  AuditRecord,
  PeopleList,
  StoredEvent,
  VisitorProfile,
} from '../store/AnalyticsStore.js';

// The identity gate, over HTTP, and the audit row every read through it writes.
//
// This is the file the ticket's "a 403 on every identity field without the scope"
// line is about, and the one that proves the log cannot drift from the body: every
// case that reads an address or a name also asserts the row, and every case that
// reads neither asserts that no row appeared.

const HOUR = 60 * 60 * 1000;

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    siteId: SITE_ID,
    ts: NOW - HOUR,
    receivedAt: NOW - HOUR,
    type: 'pageview',
    visitorId: 'v_1',
    path: '/pricing',
    hostname: 'test.example',
    bot: false,
    ip: '203.0.113.7',
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country: 'BD', city: 'Dhaka' },
    ...overrides,
  };
}

describe('reading about a person', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    await harness.store.ingest([
      event(),
      event({ ts: NOW - 50 * 60_000, receivedAt: NOW - 50 * 60_000, path: '/checkout' }),
      event({
        ts: NOW - 40 * 60_000,
        receivedAt: NOW - 40 * 60_000,
        type: 'identify',
        userId: 'u_42',
        traits: { plan: 'pro' },
      }),
    ]);
  });

  afterEach(async () => {
    await harness.close();
  });

  function trail(): Promise<AuditRecord[]> {
    return harness.store.auditTrail(SITE_ID, 0, NOW + HOUR);
  }

  describe('GET /visitors/:visitorId', () => {
    it('carries the address, the name and the traits for a caller who may see them', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/visitors/v_1`,
        headers: { cookie: harness.owner.cookie },
      });
      expect(response.statusCode).toBe(200);
      const profile = envelope<VisitorProfile>(response.body).data;
      expect(profile?.ips).toEqual(['203.0.113.7']);
      expect(profile?.userId).toBe('u_42');
      expect(profile?.traits).toEqual({ plan: 'pro' });
      expect(profile?.pageviews).toBe(2);

      const rows = await trail();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        siteId: SITE_ID,
        action: 'read:identity',
        route: 'GET /api/sites/:siteId/visitors/:visitorId',
        target: 'v_1',
        fields: ['ips', 'traits', 'userId'],
        actor: { kind: 'session', id: harness.owner.userId },
      });
    });

    // The page, the device and the counts are traffic. The address and the name are
    // not, so a viewer sees the visit and not the visitor.
    it('strips them for a caller who may not, and writes no row', async () => {
      const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/visitors/v_1`,
        headers: { cookie: viewer.cookie },
      });
      expect(response.statusCode).toBe(200);
      const profile = envelope<VisitorProfile>(response.body).data;
      expect(profile?.ips).toEqual([]);
      expect(profile).not.toHaveProperty('userId');
      expect(profile).not.toHaveProperty('traits');
      expect(profile?.pageviews).toBe(2);
      expect(response.body).not.toContain('203.0.113.7');
      expect(response.body).not.toContain('u_42');

      // Nothing personal was revealed, so nothing belongs in a log whose purpose is
      // "who looked at this person".
      expect(await trail()).toEqual([]);
    });

    it('lets a viewer who was granted identity see them, and logs that read', async () => {
      const trusted = await harness.account({
        email: 'trusted@test.example',
        role: 'viewer',
        identity: true,
      });
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/visitors/v_1`,
        headers: { cookie: trusted.cookie },
      });
      expect(envelope<VisitorProfile>(response.body).data?.ips).toEqual(['203.0.113.7']);
      expect((await trail())[0]).toMatchObject({ actor: { id: trusted.userId } });
    });

    it('answers 404 for a visitor nobody has seen', async () => {
      expectFailure(
        await harness.app.inject({
          method: 'GET',
          url: `/api/sites/${SITE_ID}/visitors/v_nobody`,
          headers: { cookie: harness.owner.cookie },
        }),
        404,
        'UNKNOWN_VISITOR',
      );
    });
  });

  describe('GET /users/:userId', () => {
    // To reach this route you have to already know the person's id, so the request
    // itself is "tell me about this named person". There is no version of that
    // answer with the person taken out.
    it('refuses a caller without read:identity outright', async () => {
      const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
      expectFailure(
        await harness.app.inject({
          method: 'GET',
          url: `/api/sites/${SITE_ID}/users/u_42`,
          headers: { cookie: viewer.cookie },
        }),
        403,
        'SCOPE_REQUIRED',
      );
      expect(await trail()).toEqual([]);
    });

    it('answers the profile for a caller with the scope and logs the read', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/users/u_42`,
        headers: { cookie: harness.owner.cookie },
      });
      expect(response.statusCode).toBe(200);
      const profile = envelope<{ userId: string; visitorIds: string[]; ips: string[] }>(
        response.body,
      ).data;
      expect(profile?.userId).toBe('u_42');
      expect(profile?.visitorIds).toEqual(['v_1']);
      expect(profile?.ips).toEqual(['203.0.113.7']);

      expect((await trail())[0]).toMatchObject({
        route: 'GET /api/sites/:siteId/users/:userId',
        target: 'u_42',
        fields: ['ips', 'traits', 'userId'],
      });
    });

    it('answers 404 for somebody nobody has identified', async () => {
      expectFailure(
        await harness.app.inject({
          method: 'GET',
          url: `/api/sites/${SITE_ID}/users/u_nobody`,
          headers: { cookie: harness.owner.cookie },
        }),
        404,
        'UNKNOWN_USER',
      );
    });

    it('refuses a key that was not given read:identity', async () => {
      expectFailure(
        await harness.app.inject({
          method: 'GET',
          url: `/api/sites/${SITE_ID}/users/u_42`,
          headers: { authorization: await harness.key(['read:stats']) },
        }),
        403,
        'SCOPE_REQUIRED',
      );
    });

    it('lets a key that was given it through, and logs the key as the actor', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/users/u_42`,
        headers: { authorization: await harness.key(['read:stats', 'read:identity']) },
      });
      expect(response.statusCode).toBe(200);
      const rows = await trail();
      expect(rows[0]?.actor.kind).toBe('key');
      expect(rows[0]?.actor.email).toBeUndefined();
    });
  });

  describe('GET /users/:userId/presence', () => {
    it('says a person is offline when their last sign of life is old', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/users/u_42/presence`,
        headers: { cookie: harness.owner.cookie },
      });
      expect(response.statusCode).toBe(200);
      const presence = envelope<{ online: boolean; lastSeenAt: number }>(response.body).data;
      expect(presence?.online).toBe(false);
      expect(presence?.lastSeenAt).toBe(NOW - 40 * 60_000);
    });

    it('says they are online, where, and since when', async () => {
      await harness.store.ingest([
        event({ ts: NOW - 10_000, receivedAt: NOW - 10_000, path: '/now', userId: 'u_42' }),
      ]);
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/users/u_42/presence`,
        headers: { cookie: harness.owner.cookie },
      });
      const presence = envelope<{ online: boolean; page: string; since: number }>(response.body)
        .data;
      expect(presence?.online).toBe(true);
      expect(presence?.page).toBe('/now');
      expect(presence?.since).toBeLessThanOrEqual(NOW - 10_000);
    });

    // Asking "is this named person online" is a read about them whatever the answer
    // is, so the row is written even when they are not.
    it('logs the read even when the answer is no', async () => {
      await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/users/u_42/presence`,
        headers: { cookie: harness.owner.cookie },
      });
      expect((await trail())[0]).toMatchObject({
        route: 'GET /api/sites/:siteId/users/:userId/presence',
        target: 'u_42',
        fields: ['userId'],
      });
    });

    it('needs read:identity like the profile does', async () => {
      const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
      expectFailure(
        await harness.app.inject({
          method: 'GET',
          url: `/api/sites/${SITE_ID}/users/u_42/presence`,
          headers: { cookie: viewer.cookie },
        }),
        403,
        'SCOPE_REQUIRED',
      );
    });
  });

  // The directory (AN-PPL02). Listing is traffic and is stripped like the
  // visitor route; searching can match a name and is refused without the scope
  // before anything is read, so a refusal writes no row either.
  describe('GET /people', () => {
    beforeEach(async () => {
      await harness.store.ingest([
        event({ visitorId: 'v_2', ts: NOW - 20 * 60_000, receivedAt: NOW - 20 * 60_000 }),
        event({ visitorId: 'v_3', ts: NOW - 10 * 60_000, receivedAt: NOW - 10 * 60_000 }),
      ]);
    });

    function list(url: string, headers: Record<string, string>) {
      return harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/people${url}`,
        headers,
      });
    }

    it('lists everybody newest first, names included, and logs the page once', async () => {
      const response = await list('', { cookie: harness.owner.cookie });
      expect(response.statusCode).toBe(200);
      const parsed = envelope<PeopleList>(response.body);
      expect(parsed.success).toBe(true);
      expect(parsed.meta).toMatchObject({ identity: true, limit: 50 });
      expect(parsed.data?.people.map((row) => row.visitorId)).toEqual(['v_3', 'v_2', 'v_1']);
      expect(parsed.data?.next).toBeNull();
      const named = parsed.data?.people[2];
      expect(named?.userId).toBe('u_42');
      expect(named?.traits).toEqual({ plan: 'pro' });
      expect(named?.ips).toEqual(['203.0.113.7']);

      const rows = await trail();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        route: 'GET /api/sites/:siteId/people',
        fields: ['ips', 'traits', 'userId'],
        actor: { kind: 'session', id: harness.owner.userId },
      });
      expect(rows[0]?.target).toBeUndefined();
    });

    it('strips the names and addresses for a viewer, and writes no row', async () => {
      const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
      const response = await list('?identifiedOnly=true', { cookie: viewer.cookie });
      expect(response.statusCode).toBe(200);
      const parsed = envelope<PeopleList>(response.body);
      expect(parsed.meta).toMatchObject({ identity: false });
      expect(parsed.data?.people.map((row) => row.visitorId)).toEqual(['v_1']);
      expect(parsed.data?.people[0]?.ips).toEqual([]);
      expect(response.body).not.toContain('203.0.113.7');
      expect(response.body).not.toContain('u_42');
      expect(response.body).not.toContain('"plan"');
      expect(await trail()).toEqual([]);
    });

    it('refuses a search without read:identity, to an account and to a key', async () => {
      const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
      expectFailure(await list('?q=u_4', { cookie: viewer.cookie }), 403, 'SCOPE_REQUIRED');
      expectFailure(
        await list('?q=v_', { authorization: await harness.key(['read:stats']) }),
        403,
        'SCOPE_REQUIRED',
      );
      expect(await trail()).toEqual([]);
    });

    it('answers a search with the scope and names it in the log', async () => {
      const response = await list('?q=U_4', {
        authorization: await harness.key(['read:stats', 'read:identity']),
      });
      expect(response.statusCode).toBe(200);
      const parsed = envelope<PeopleList>(response.body);
      expect(parsed.data?.people.map((row) => row.visitorId)).toEqual(['v_1']);
      const rows = await trail();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ target: 'U_4', actor: { kind: 'key' } });
    });

    it('treats an empty search box as no search, which needs no scope', async () => {
      const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
      const response = await list('?q=%20%20', { cookie: viewer.cookie });
      expect(response.statusCode).toBe(200);
      expect(envelope<PeopleList>(response.body).data?.people).toHaveLength(3);
    });

    it('walks every page by the cursor it hands out, no row twice', async () => {
      const seen: string[] = [];
      let cursor: string | null = '';
      for (let pages = 0; cursor !== null && pages < 10; pages += 1) {
        const suffix: string = cursor === '' ? '?limit=1' : `?limit=1&cursor=${cursor}`;
        const response = await list(suffix, { cookie: harness.owner.cookie });
        const parsed = envelope<PeopleList>(response.body);
        seen.push(...(parsed.data?.people.map((row) => row.visitorId) ?? []));
        cursor = parsed.data?.next ?? null;
      }
      expect(seen).toEqual(['v_3', 'v_2', 'v_1']);
    });

    it('refuses a query it cannot read, in the envelope', async () => {
      const owner = { cookie: harness.owner.cookie };
      const long = 'x'.repeat(201);
      expectFailure(await list('?cursor=nonsense', owner), 400, 'INVALID_CURSOR');
      expectFailure(await list('?limit=0', owner), 400, 'INVALID_PEOPLE_QUERY');
      expectFailure(await list('?limit=101', owner), 400, 'INVALID_PEOPLE_QUERY');
      expectFailure(await list('?identifiedOnly=yes', owner), 400, 'INVALID_PEOPLE_QUERY');
      expectFailure(await list('?q=' + long, owner), 400, 'INVALID_PEOPLE_QUERY');
    });
  });

  it('refuses every one of them to nobody at all', async () => {
    for (const url of [
      `/api/sites/${SITE_ID}/people`,
      `/api/sites/${SITE_ID}/visitors/v_1`,
      `/api/sites/${SITE_ID}/users/u_42`,
      `/api/sites/${SITE_ID}/users/u_42/presence`,
      `/api/sites/${SITE_ID}/realtime`,
    ]) {
      expectFailure(await harness.app.inject({ method: 'GET', url }), 401, 'UNAUTHENTICATED');
    }
    expect(await trail()).toEqual([]);
  });
});
