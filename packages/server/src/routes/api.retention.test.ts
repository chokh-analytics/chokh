import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  NOW,
  SITE_ID,
  testSite,
  type Harness,
} from './api.test-utils.js';
import {
  goalIdFor,
  type ActivityResult,
  type AttributionResult,
  type AuditRecord,
  type CohortResult,
  type PowerUsersResult,
  type StoredEvent,
} from '../store/AnalyticsStore.js';

// The retention routes over HTTP (AN-PPL01): the envelope, the scope, the
// strict query strings, the goal resolved against the site, and the power
// users through the identity gate with the audit row it writes. The numbers
// themselves are the conformance suite's; these cases prove what reaches the
// wire.

const DAY = 24 * 60 * 60 * 1000;
const OTHER_SITE = 's_other';
const SIGNUP_ID = goalIdFor(SITE_ID, 'event', 'signup');

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    siteId: SITE_ID,
    ts: NOW - DAY,
    receivedAt: NOW - DAY,
    type: 'pageview',
    visitorId: 'v_1',
    path: '/',
    hostname: 'test.example',
    bot: false,
    ip: '203.0.113.7',
    ...overrides,
  };
}

describe('the retention routes', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      sites: [
        testSite({ settings: { ...testSite().settings, visitorIdMode: 'persistent' } }),
        testSite({ id: OTHER_SITE, domains: ['other.example'] }),
      ],
    });
    // v_1 is named and came on three days, signing up on the last; v_2 came
    // on two days from a campaign.
    await harness.store.ingest([
      event({ ts: NOW - 3 * DAY, receivedAt: NOW - 3 * DAY, utm: { source: 'news', medium: 'email' } }),
      event({
        ts: NOW - 3 * DAY + 60_000,
        receivedAt: NOW - 3 * DAY + 60_000,
        type: 'identify',
        userId: 'u_ada',
        traits: { name: 'Ada' },
      }),
      event({ ts: NOW - 2 * DAY, receivedAt: NOW - 2 * DAY }),
      event({ ts: NOW - DAY, receivedAt: NOW - DAY }),
      event({ ts: NOW - DAY + 60_000, receivedAt: NOW - DAY + 60_000, type: 'event', name: 'signup' }),
      event({ visitorId: 'v_2', ts: NOW - 2 * DAY, receivedAt: NOW - 2 * DAY, ip: '198.51.100.4' }),
      event({ visitorId: 'v_2', ts: NOW - DAY, receivedAt: NOW - DAY, ip: '198.51.100.4' }),
    ]);
    for (const siteId of [SITE_ID, OTHER_SITE]) {
      await harness.store.createGoal({
        siteId,
        id: goalIdFor(siteId, 'event', 'signup'),
        kind: 'event',
        match: 'signup',
        name: 'Signed up',
        value: 3,
        createdBy: harness.owner.userId,
        createdAt: NOW - 10 * DAY,
      });
    }
  });

  afterEach(async () => {
    await harness.close();
  });

  const range = `from=${NOW - 30 * DAY}&to=${NOW}`;

  function get(path: string, headers: Record<string, string> = { cookie: harness.owner.cookie }) {
    return harness.app.inject({ method: 'GET', url: `/api/sites/${SITE_ID}${path}`, headers });
  }

  function trail(): Promise<AuditRecord[]> {
    return harness.store.auditTrail(SITE_ID, 0, NOW + DAY);
  }

  describe('GET /stats/cohorts', () => {
    it('answers the grid in the envelope, weekly unless asked, raw and saying so', async () => {
      const response = await get(`/stats/cohorts?${range}`);
      expect(response.statusCode).toBe(200);
      const body = envelope<CohortResult>(response.body);
      expect(body.success).toBe(true);
      expect(body.data?.interval).toBe('week');
      expect(body.data?.cohorts.reduce((sum, cohort) => sum + cohort.visitors, 0)).toBe(2);
      expect(body.meta).toMatchObject({
        siteId: SITE_ID,
        timezone: 'UTC',
        interval: 'week',
        rawOnly: true,
        retentionDays: expect.any(Number),
        visitorIdMode: 'persistent',
      });
      const monthly = envelope<CohortResult>((await get(`/stats/cohorts?${range}&interval=month`)).body);
      expect(monthly.data?.interval).toBe('month');
    });

    it('refuses a filter, a backwards range, an unknown interval and a range too long', async () => {
      expectFailure(await get(`/stats/cohorts?${range}&filters=page==/`), 400, 'INVALID_QUERY');
      expectFailure(await get(`/stats/cohorts?from=${NOW}&to=${NOW - DAY}`), 400, 'INVALID_RANGE');
      expectFailure(await get(`/stats/cohorts?${range}&interval=day`), 400, 'INVALID_QUERY');
      expectFailure(
        await get(`/stats/cohorts?from=${NOW - 400 * DAY}&to=${NOW}`),
        400,
        'RANGE_TOO_LONG',
      );
    });
  });

  describe('GET /stats/activity', () => {
    it('answers stickiness, the returning rate and the curve', async () => {
      const response = await get(`/stats/activity?${range}`);
      expect(response.statusCode).toBe(200);
      const body = envelope<ActivityResult>(response.body);
      expect(body.data?.visitors).toBe(2);
      expect(body.data?.returning).toBe(2);
      expect(body.data?.days).toHaveLength(31);
      expect(body.meta).toMatchObject({ rawOnly: true });
    });

    it('refuses more than ninety days and anything it cannot honour', async () => {
      expectFailure(
        await get(`/stats/activity?from=${NOW - 120 * DAY}&to=${NOW}`),
        400,
        'RANGE_TOO_LONG',
      );
      expectFailure(await get(`/stats/activity?${range}&compare=previous_period`), 400, 'INVALID_QUERY');
    });
  });

  describe('GET /stats/attribution', () => {
    it('splits the goal both ways, every column adding up', async () => {
      const response = await get(`/stats/attribution?${range}&goal=${SIGNUP_ID}`);
      expect(response.statusCode).toBe(200);
      const body = envelope<AttributionResult>(response.body);
      expect(body.data).toMatchObject({ dim: 'channel', visitors: 1, completions: 1, value: 3 });
      const keys = new Map(body.data?.rows.map((row) => [row.key, row]));
      expect(keys.get('email')?.first.visitors).toBe(1);
      expect(keys.get('direct')?.last.visitors).toBe(1);
      expect(body.meta).toMatchObject({ goal: SIGNUP_ID, dim: 'channel', rawOnly: true });
      const bySource = envelope<AttributionResult>(
        (await get(`/stats/attribution?${range}&goal=${SIGNUP_ID}&dim=utm_source`)).body,
      );
      expect(bySource.data?.rows.map((row) => row.key).sort()).toEqual(['', 'news']);
    });

    it('needs a goal of this site and a dimension it can split by', async () => {
      expectFailure(await get(`/stats/attribution?${range}`), 400, 'INVALID_QUERY');
      expectFailure(await get(`/stats/attribution?${range}&goal=g_nope`), 404, 'GOAL_NOT_FOUND');
      expectFailure(
        await get(`/stats/attribution?${range}&goal=${goalIdFor(OTHER_SITE, 'event', 'signup')}`),
        404,
        'GOAL_NOT_FOUND',
      );
      expectFailure(
        await get(`/stats/attribution?${range}&goal=${SIGNUP_ID}&dim=country`),
        400,
        'INVALID_QUERY',
      );
    });
  });

  describe('GET /stats/power-users', () => {
    it('names them for a caller who may see names, and logs the read', async () => {
      const response = await get(`/stats/power-users?${range}&minDays=2`);
      expect(response.statusCode).toBe(200);
      const body = envelope<PowerUsersResult>(response.body);
      expect(body.data?.people.map((row) => [row.visitorId, row.activeDays])).toEqual([
        ['v_1', 3],
        ['v_2', 2],
      ]);
      expect(body.data?.people[0]).toMatchObject({ userId: 'u_ada', traits: { name: 'Ada' } });
      expect(body.meta).toMatchObject({ identity: true, limit: 20 });
      const rows = await trail();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'read:identity',
        route: 'GET /api/sites/:siteId/stats/power-users',
        fields: ['ips', 'traits', 'userId'],
        actor: { kind: 'session', id: harness.owner.userId },
      });
    });

    it('strips them for a viewer and for a read:stats key, and writes no row', async () => {
      const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
      const callers: Record<string, string>[] = [
        { cookie: viewer.cookie },
        { authorization: await harness.key(['read:stats']) },
      ];
      for (const headers of callers) {
        const response = await get(`/stats/power-users?${range}&minDays=2`, headers);
        expect(response.statusCode).toBe(200);
        const body = envelope<PowerUsersResult>(response.body);
        expect(body.data?.people).toHaveLength(2);
        expect(body.data?.people[0]).not.toHaveProperty('userId');
        expect(body.data?.people[0]).not.toHaveProperty('traits');
        expect(body.data?.people[0]?.ips).toEqual([]);
        expect(response.body).not.toContain('u_ada');
        expect(response.body).not.toContain('203.0.113.7');
        expect(body.meta).toMatchObject({ identity: false });
      }
      expect(await trail()).toEqual([]);
    });

    it('lets a key with read:identity through and logs the key', async () => {
      const response = await get(`/stats/power-users?${range}&minDays=2&limit=1`, {
        authorization: await harness.key(['read:stats', 'read:identity']),
      });
      const body = envelope<PowerUsersResult>(response.body);
      expect(body.data?.people.map((row) => row.userId)).toEqual(['u_ada']);
      const rows = await trail();
      expect(rows[0]?.actor.kind).toBe('key');
    });

    it('takes a third of the range by default, and refuses what it cannot honour', async () => {
      const body = envelope<PowerUsersResult>((await get(`/stats/power-users?${range}`)).body);
      // Thirty one days of the calendar, so eleven.
      expect(body.data).toMatchObject({ days: 31, minDays: 11, people: [] });
      expectFailure(await get(`/stats/power-users?${range}&limit=101`), 400, 'INVALID_QUERY');
      expectFailure(await get(`/stats/power-users?${range}&q=ada`), 400, 'INVALID_QUERY');
    });
  });

  it('answers 401 unsigned and 403 to a key without read:stats on every route', async () => {
    const key = await harness.key(['write:events']);
    for (const path of [
      `/stats/cohorts?${range}`,
      `/stats/activity?${range}`,
      `/stats/attribution?${range}&goal=${SIGNUP_ID}`,
      `/stats/power-users?${range}`,
    ]) {
      expectFailure(
        await harness.app.inject({ method: 'GET', url: `/api/sites/${SITE_ID}${path}` }),
        401,
        'UNAUTHENTICATED',
      );
      const refused = await get(path, { authorization: key });
      expect(refused.statusCode).toBe(403);
      expect(envelope(refused.body).success).toBe(false);
    }
  });
});
