import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  type BreakdownRow,
  type Conversion,
  type EventsResult,
  type Goal,
  type PropertyResult,
  type StoredEvent,
} from '../store/AnalyticsStore.js';

// Goals over HTTP: the three routes that keep them, and every report that takes
// one or answers about events.
//
// The site is in UTC, so the numbers read off the clock. Today v_1 from Dhaka
// reads /pricing and signs up on the pro plan, and v_2 from Kolkata reads two
// pages and does not. Yesterday, which is rolled up, v_3 from Dhaka signs up on
// the free plan. So over both days three visitors came and two signed up.

const OTHER_SITE = 's_other';
const TODAY_START = Date.UTC(2026, 8, 18);
const YESTERDAY_START = Date.UTC(2026, 8, 17);
const HOUR = 60 * 60 * 1000;
const SIGNUP_ID = goalIdFor(SITE_ID, 'event', 'signup');

function row(
  visitorId: string,
  ts: number,
  over: Partial<StoredEvent>,
  country: 'BD' | 'IN',
): StoredEvent {
  return {
    siteId: SITE_ID,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId,
    hostname: 'test.example',
    bot: false,
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country, city: country === 'BD' ? 'Dhaka' : 'Kolkata' },
    lang: 'en',
    ...over,
  };
}

describe('goals and the reports that take one', () => {
  let harness: Harness;
  let owner: string;
  let viewer: string;

  beforeAll(async () => {
    harness = await createHarness({
      sites: [testSite(), testSite({ id: OTHER_SITE, domains: ['other.example'] })],
    });
    owner = harness.owner.cookie;
    viewer = (await harness.account({ email: 'viewer@test.example', role: 'viewer' })).cookie;

    await harness.store.ingest([
      row('v_3', YESTERDAY_START + 12 * HOUR, { path: '/' }, 'BD'),
      row(
        'v_3',
        YESTERDAY_START + 12 * HOUR + 5 * 60_000,
        { type: 'event', name: 'signup', path: '/', props: { plan: 'free' } },
        'BD',
      ),
    ]);
    await harness.store.rollupDay(SITE_ID, '2026-09-17');
    await harness.store.ingest([
      row('v_1', NOW - HOUR, { path: '/pricing' }, 'BD'),
      row(
        'v_1',
        NOW - 55 * 60_000,
        { type: 'event', name: 'signup', path: '/pricing', props: { plan: 'pro' } },
        'BD',
      ),
      row('v_2', NOW - 30 * 60_000, { path: '/pricing' }, 'IN'),
      row('v_2', NOW - 29 * 60_000, { path: '/' }, 'IN'),
    ]);
  });

  afterAll(async () => {
    await harness.close();
  });

  function call(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) {
    return harness.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  const goals = `/api/sites/${SITE_ID}/goals`;
  const range = `from=${YESTERDAY_START}&to=${NOW}`;

  describe('the goal routes', () => {
    it('adds a goal for an owner, with an id derived from the question', async () => {
      const response = await call('POST', goals, { cookie: owner }, {
        name: 'Signed up',
        kind: 'event',
        match: 'signup',
        value: 5,
      });
      expect(response.statusCode).toBe(201);
      const goal = envelope<{ goal: Goal }>(response.body).data?.goal;
      expect(goal).toEqual({
        siteId: SITE_ID,
        id: SIGNUP_ID,
        name: 'Signed up',
        kind: 'event',
        match: 'signup',
        value: 5,
        createdBy: harness.owner.userId,
        createdAt: NOW,
      });

      const listed = await call('GET', goals, { cookie: owner });
      const body = envelope<{ goals: Goal[] }>(listed.body);
      expect(body.data?.goals.map((each) => each.id)).toEqual([SIGNUP_ID]);
      expect(body.meta).toEqual({ siteId: SITE_ID, max: 50 });
    });

    it('refuses the same question asked twice, and names the goal that asks it', async () => {
      const response = await call('POST', goals, { cookie: owner }, {
        name: 'Another name',
        kind: 'event',
        match: 'signup',
      });
      expectFailure(response, 409, 'GOAL_EXISTS');
      const failure = JSON.parse(response.body) as { error: { details: { goalId: string } } };
      expect(failure.error.details.goalId).toBe(SIGNUP_ID);
    });

    it.each([
      ['a path that does not start with a slash', { name: 'x', kind: 'page', match: 'pricing' }],
      ['a kind there is not', { name: 'x', kind: 'click', match: 'signup' }],
      ['a negative value', { name: 'x', kind: 'event', match: 'signup', value: -1 }],
      ['a blank name', { name: '   ', kind: 'event', match: 'signup' }],
      ['a field nobody asked for', { name: 'x', kind: 'event', match: 'signup', extra: 1 }],
    ])('refuses %s with the envelope', async (_why, body) => {
      expectFailure(await call('POST', goals, { cookie: owner }, body), 400, 'INVALID_GOAL');
    });

    // The hooks are built for each route, so a viewer who may read the list is
    // refused both writes, and the refusal names the scope rather than the site.
    it('lets a viewer read the list and refuses them both writes', async () => {
      expect((await call('GET', goals, { cookie: viewer })).statusCode).toBe(200);
      expectFailure(
        await call('POST', goals, { cookie: viewer }, { name: 'x', kind: 'event', match: 'x' }),
        403,
        'SCOPE_REQUIRED',
      );
      expectFailure(
        await call('DELETE', `${goals}/${SIGNUP_ID}`, { cookie: viewer }),
        403,
        'SCOPE_REQUIRED',
      );
    });

    it('lets a key with admin add one, and records the key as who added it', async () => {
      const reader = await harness.key(['read:stats']);
      expectFailure(
        await call('POST', goals, { authorization: reader }, {
          name: 'Pricing',
          kind: 'page',
          match: '/pricing',
        }),
        403,
        'SCOPE_REQUIRED',
      );
      const admin = await harness.key(['read:stats', 'admin']);
      const response = await call('POST', goals, { authorization: admin }, {
        name: 'Pricing',
        kind: 'page',
        match: '/pricing',
      });
      expect(response.statusCode).toBe(201);
      const goal = envelope<{ goal: Goal }>(response.body).data?.goal;
      expect(goal?.createdBy).toMatch(/^k_/);
      expect(goal).not.toHaveProperty('value');
    });

    it('deletes once, then says there is no such goal', async () => {
      const pricing = goalIdFor(SITE_ID, 'page', '/pricing');
      const first = await call('DELETE', `${goals}/${pricing}`, { cookie: owner });
      expect(envelope(first.body)).toEqual({ success: true, data: { deleted: true } });
      expectFailure(
        await call('DELETE', `${goals}/${pricing}`, { cookie: owner }),
        404,
        'GOAL_NOT_FOUND',
      );
    });

    it('refuses nobody with the envelope', async () => {
      expectFailure(await call('GET', goals, {}), 401, 'UNAUTHENTICATED');
    });
  });

  describe('a report asked with a goal', () => {
    it('carries a conversion on every row of a breakdown', async () => {
      const response = await call(
        'GET',
        `/api/sites/${SITE_ID}/stats/breakdown?${range}&dim=country&goal=${SIGNUP_ID}`,
        { cookie: owner },
      );
      expect(response.statusCode).toBe(200);
      const body = envelope<{ rows: BreakdownRow[] }>(response.body);
      const rows = new Map(body.data?.rows.map((each) => [each.key, each.conversion]));
      expect(rows.get('BD')).toEqual({ visitors: 2, completions: 2, rate: 1, value: 10 });
      expect(rows.get('IN')).toEqual({ visitors: 0, completions: 0, rate: 0, value: 0 });
      expect(body.data?.rows.every((each) => each.conversion !== undefined)).toBe(true);
      // A goal read is raw for the whole range, and the meta says how far back
      // that is.
      expect(body.meta).toMatchObject({
        rawOnly: true,
        retentionDays: 180,
        goal: SIGNUP_ID,
      });
    });

    it('carries no conversion on a breakdown asked without one', async () => {
      const response = await call(
        'GET',
        `/api/sites/${SITE_ID}/stats/breakdown?${range}&dim=country`,
        { cookie: owner },
      );
      const body = envelope<{ rows: BreakdownRow[] }>(response.body);
      expect(body.data?.rows.some((each) => each.conversion !== undefined)).toBe(false);
      expect(body.meta).not.toHaveProperty('rawOnly');
    });

    it('carries a conversion on the aggregate, and on the period before when it compares', async () => {
      const response = await call(
        'GET',
        `/api/sites/${SITE_ID}/stats/aggregate?from=${TODAY_START}&to=${NOW}&compare=previous_period&goal=${SIGNUP_ID}`,
        { cookie: owner },
      );
      const body = envelope<{
        conversion: Conversion;
        previousConversion: Conversion;
        metrics: { visitors: number };
      }>(response.body);
      expect(body.data?.metrics.visitors).toBe(2);
      expect(body.data?.conversion).toEqual({ visitors: 1, completions: 1, rate: 0.5, value: 5 });
      expect(body.data?.previousConversion).toEqual({
        visitors: 1,
        completions: 1,
        rate: 1,
        value: 5,
      });
    });

    it('answers a goal that is not here with 404', async () => {
      expectFailure(
        await call(
          'GET',
          `/api/sites/${SITE_ID}/stats/breakdown?${range}&dim=country&goal=g_nothing`,
          { cookie: owner },
        ),
        404,
        'GOAL_NOT_FOUND',
      );
    });

    // A key belongs to one site, and a goal id belongs to one site too: naming
    // this site's goal at the other site is a goal the other site does not have.
    it("never lets a key of another site borrow this site's goal", async () => {
      const elsewhere = await harness.key(['read:stats'], OTHER_SITE);
      expectFailure(
        await call(
          'GET',
          `/api/sites/${OTHER_SITE}/stats/breakdown?${range}&dim=country&goal=${SIGNUP_ID}`,
          { authorization: elsewhere },
        ),
        404,
        'GOAL_NOT_FOUND',
      );
    });

    it.each(['timeseries', 'engagement'])('refuses a goal on %s', async (report) => {
      expectFailure(
        await call(
          'GET',
          `/api/sites/${SITE_ID}/stats/${report}?from=${TODAY_START}&to=${NOW}&dim=page&goal=${SIGNUP_ID}`,
          { cookie: owner },
        ),
        400,
        'UNSUPPORTED_GOAL',
      );
    });

    it('exports four more columns with a goal, and none without one', async () => {
      const plain = await call(
        'GET',
        `/api/sites/${SITE_ID}/export.csv?${range}&dim=country`,
        { cookie: owner },
      );
      expect(plain.body.split('\r\n')[0]).toBe(
        'key,visitors,pageviews,visits,bounces,bounce_rate,avg_duration_ms',
      );
      const withGoal = await call(
        'GET',
        `/api/sites/${SITE_ID}/export.csv?${range}&dim=country&goal=${SIGNUP_ID}`,
        { cookie: owner },
      );
      const lines = withGoal.body.trimEnd().split('\r\n');
      expect(lines[0]).toBe(
        'key,visitors,pageviews,visits,bounces,bounce_rate,avg_duration_ms,converted_visitors,completions,conversion_rate,value',
      );
      expect(lines.find((line) => line.startsWith('BD,'))?.endsWith(',2,2,1,10')).toBe(true);
      expect(lines.find((line) => line.startsWith('IN,'))?.endsWith(',0,0,0,0')).toBe(true);
    });
  });

  describe('the events, property and goals reports', () => {
    it('lists the custom events, read raw across a rolled day', async () => {
      const response = await call('GET', `/api/sites/${SITE_ID}/stats/events?${range}`, {
        cookie: viewer,
      });
      const body = envelope<EventsResult>(response.body);
      expect(body.data?.visitors).toBe(3);
      expect(body.data?.rows).toEqual([{ key: 'signup', visitors: 2, events: 2, rate: 2 / 3 }]);
      expect(body.meta).toMatchObject({ rawOnly: true, retentionDays: 180 });
    });

    it('breaks one event down by its most used property', async () => {
      const response = await call(
        'GET',
        `/api/sites/${SITE_ID}/stats/properties?${range}&event=signup`,
        { cookie: viewer },
      );
      const body = envelope<PropertyResult>(response.body);
      expect(body.data?.property).toBe('plan');
      expect(body.data?.properties).toEqual([{ key: 'plan', events: 2 }]);
      expect(body.data?.rows.map((each) => [each.key, each.visitors])).toEqual([
        ['free', 1],
        ['pro', 1],
      ]);
    });

    it('says a property breakdown needs an event, by name', async () => {
      expectFailure(
        await call('GET', `/api/sites/${SITE_ID}/stats/properties?${range}`, { cookie: owner }),
        400,
        'MISSING_EVENT',
      );
    });

    it('answers every goal at once, each with its goal', async () => {
      const response = await call('GET', `/api/sites/${SITE_ID}/stats/goals?${range}`, {
        cookie: viewer,
      });
      const body = envelope<{ visitors: number; rows: { goal: Goal; conversion: Conversion }[] }>(
        response.body,
      );
      expect(body.data?.visitors).toBe(3);
      expect(body.data?.rows).toHaveLength(1);
      expect(body.data?.rows[0]?.goal.id).toBe(SIGNUP_ID);
      expect(body.data?.rows[0]?.conversion).toEqual({
        visitors: 2,
        completions: 2,
        rate: 2 / 3,
        value: 10,
      });
      expectFailure(
        await call('GET', `/api/sites/${SITE_ID}/stats/goals?${range}&goal=${SIGNUP_ID}`, {
          cookie: viewer,
        }),
        400,
        'UNSUPPORTED_GOAL',
      );
    });
  });
});
