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
  funnelIdFor,
  goalIdFor,
  type Funnel,
  type FunnelResult,
  type JourneyResult,
  type StoredEvent,
} from '../store/AnalyticsStore.js';

// Funnels and journeys over HTTP: the three routes that keep funnels and the two
// reports that read them.
//
// The site is in UTC and cookieless, the public default. In the last two hours
// v_1 came from a search, read /pricing and signed up five minutes later; v_2
// came direct, read /pricing and then /docs; v_3 came from Facebook, read the
// home page, then /pricing, and signed up eight minutes after that.

const OTHER_SITE = 's_other';
const MINUTE = 60_000;
const SIGNUP_ID = goalIdFor(SITE_ID, 'event', 'signup');
const PRICING = { kind: 'page', match: '/pricing' } as const;
const SIGNUP = { kind: 'event', match: 'signup' } as const;

function row(visitorId: string, minutesAgo: number, over: Partial<StoredEvent>): StoredEvent {
  const ts = NOW - minutesAgo * MINUTE;
  return {
    siteId: SITE_ID,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId,
    hostname: 'test.example',
    bot: false,
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country: 'BD', city: 'Dhaka' },
    lang: 'en',
    ...over,
  };
}

describe('funnels and journeys', () => {
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
      row('v_1', 120, { path: '/pricing', referrer: 'https://www.google.com/' }),
      row('v_1', 115, { type: 'event', name: 'signup', path: '/pricing' }),
      row('v_2', 90, { path: '/pricing' }),
      row('v_2', 89, { path: '/docs' }),
      row('v_3', 60, { path: '/', referrer: 'https://www.facebook.com/' }),
      row('v_3', 58, { path: '/pricing' }),
      row('v_3', 50, { type: 'event', name: 'signup', path: '/pricing' }),
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

  const funnels = `/api/sites/${SITE_ID}/funnels`;
  const range = `from=${NOW - 3 * 60 * MINUTE}&to=${NOW}`;
  const checkout = {
    name: 'Checkout',
    window: '1d',
    steps: [{ page: '/pricing' }, { goalId: SIGNUP_ID, name: 'Signed up' }],
  };
  const CHECKOUT_ID = funnelIdFor(SITE_ID, '1d', [PRICING, SIGNUP]);

  describe('the funnel routes', () => {
    beforeAll(async () => {
      const created = await call('POST', `/api/sites/${SITE_ID}/goals`, { cookie: owner }, {
        name: 'Signup',
        kind: 'event',
        match: 'signup',
      });
      expect(created.statusCode).toBe(201);
    });

    it('adds a funnel from a path and a goal, copying the goal, with a derived id', async () => {
      const response = await call('POST', funnels, { cookie: owner }, checkout);
      expect(response.statusCode).toBe(201);
      expect(envelope<{ funnel: Funnel }>(response.body).data?.funnel).toEqual({
        siteId: SITE_ID,
        id: CHECKOUT_ID,
        name: 'Checkout',
        window: '1d',
        steps: [
          { kind: 'page', match: '/pricing', name: '/pricing' },
          { kind: 'event', match: 'signup', name: 'Signed up', goalId: SIGNUP_ID },
        ],
        createdBy: harness.owner.userId,
        createdAt: NOW,
      });

      const listed = await call('GET', funnels, { cookie: owner });
      const body = envelope<{ funnels: Funnel[] }>(listed.body);
      expect(body.data?.funnels.map((each) => each.id)).toEqual([CHECKOUT_ID]);
      expect(body.meta).toEqual({
        siteId: SITE_ID,
        max: 50,
        maxSteps: 8,
        windows: ['visit', '1h', '1d', '7d', '30d'],
        defaultWindow: 'visit',
      });
    });

    it('refuses the same funnel under another name, and names the one that asks it', async () => {
      const response = await call('POST', funnels, { cookie: owner }, {
        ...checkout,
        name: 'Another name',
        steps: [{ page: '/pricing', name: 'Pricing' }, { goalId: SIGNUP_ID }],
      });
      expectFailure(response, 409, 'FUNNEL_EXISTS');
      const failure = JSON.parse(response.body) as { error: { details: { funnelId: string } } };
      expect(failure.error.details.funnelId).toBe(CHECKOUT_ID);
    });

    it('takes the site default window when none is given: the same visit on a cookieless site', async () => {
      const response = await call('POST', funnels, { cookie: owner }, {
        name: 'Checkout in one sitting',
        steps: checkout.steps,
      });
      expect(response.statusCode).toBe(201);
      expect(envelope<{ funnel: Funnel }>(response.body).data?.funnel.window).toBe('visit');
    });

    it("refuses a goal step naming another site's goal, and says which step", async () => {
      const elsewhere = goalIdFor(OTHER_SITE, 'event', 'signup');
      const response = await call('POST', funnels, { cookie: owner }, {
        name: 'Borrowed',
        steps: [{ page: '/pricing' }, { goalId: elsewhere }],
      });
      expectFailure(response, 404, 'GOAL_NOT_FOUND');
      const failure = JSON.parse(response.body) as { error: { details: { step: number } } };
      expect(failure.error.details.step).toBe(1);
    });

    it('refuses a body that does not validate, naming the issue', async () => {
      const pricing = { page: '/pricing' };
      const bodies = [
        { name: 'One step', steps: [pricing] },
        { name: 'Nine steps', steps: Array.from({ length: 9 }, () => pricing) },
        { name: 'No slash', steps: [pricing, { page: 'pricing' }] },
        { name: 'Both', steps: [pricing, { page: '/a', goalId: SIGNUP_ID }] },
        { name: 'Bad window', window: '2d', steps: [pricing, pricing] },
        { name: '', steps: [pricing, pricing] },
      ];
      for (const body of bodies) {
        expectFailure(await call('POST', funnels, { cookie: owner }, body), 400, 'INVALID_FUNNEL');
      }
    });

    it('lets a viewer and a read:stats key read the list and refuses them both writes', async () => {
      expect((await call('GET', funnels, { cookie: viewer })).statusCode).toBe(200);
      expectFailure(await call('POST', funnels, { cookie: viewer }, checkout), 403, 'SCOPE_REQUIRED');
      expectFailure(
        await call('DELETE', `${funnels}/${CHECKOUT_ID}`, { cookie: viewer }),
        403,
        'SCOPE_REQUIRED',
      );
      const reader = await harness.key(['read:stats']);
      expect((await call('GET', funnels, { authorization: reader })).statusCode).toBe(200);
      expectFailure(
        await call('POST', funnels, { authorization: reader }, { ...checkout, window: '7d' }),
        403,
        'SCOPE_REQUIRED',
      );
    });

    it("never lets a key of another site read or borrow this site's funnels", async () => {
      const elsewhere = await harness.key(['read:stats', 'admin'], OTHER_SITE);
      expectFailure(await call('GET', funnels, { authorization: elsewhere }), 403, 'SITE_FORBIDDEN');
      expectFailure(
        await call('GET', `/api/sites/${OTHER_SITE}/stats/funnel?funnel=${CHECKOUT_ID}&${range}`, {
          authorization: elsewhere,
        }),
        404,
        'FUNNEL_NOT_FOUND',
      );
    });

    it('refuses nobody with the envelope', async () => {
      expectFailure(await call('GET', funnels, {}), 401, 'UNAUTHENTICATED');
    });
  });

  describe('the funnel report', () => {
    const report = `/api/sites/${SITE_ID}/stats/funnel`;

    it('counts how far each person got, with the drop-off and both rates', async () => {
      const response = await call('GET', `${report}?funnel=${CHECKOUT_ID}&${range}`, {
        cookie: viewer,
      });
      expect(response.statusCode).toBe(200);
      const body = envelope<FunnelResult & { funnel: Funnel }>(response.body);
      expect(body.data?.funnel.id).toBe(CHECKOUT_ID);
      expect(body.data?.visitors).toBe(3);
      expect(body.data?.steps).toEqual([
        { visitors: 3, dropOff: 0, rate: 1, stepRate: null },
        { visitors: 2, dropOff: 1, rate: 2 / 3, stepRate: 2 / 3 },
      ]);
      expect(body.meta).toMatchObject({
        siteId: SITE_ID,
        rawOnly: true,
        retentionDays: 180,
        funnel: CHECKOUT_ID,
      });
    });

    it('narrows the people with a filter only a stay carries', async () => {
      const filters = encodeURIComponent('channel==social');
      const response = await call(
        'GET',
        `${report}?funnel=${CHECKOUT_ID}&${range}&filters=${filters}`,
        { cookie: viewer },
      );
      const body = envelope<FunnelResult>(response.body);
      expect(body.data?.visitors).toBe(1);
      expect(body.data?.steps.map((step) => step.visitors)).toEqual([1, 1]);
    });

    it('says a funnel report needs a funnel, by name, and refuses a goal', async () => {
      expectFailure(await call('GET', `${report}?${range}`, { cookie: viewer }), 400, 'MISSING_FUNNEL');
      expectFailure(
        await call('GET', `${report}?funnel=${CHECKOUT_ID}&goal=${SIGNUP_ID}&${range}`, {
          cookie: viewer,
        }),
        400,
        'UNSUPPORTED_GOAL',
      );
      expectFailure(
        await call('GET', `${report}?funnel=f_nothing&${range}`, { cookie: viewer }),
        404,
        'FUNNEL_NOT_FOUND',
      );
    });

    it('keeps its numbers when the goal it was made from is deleted', async () => {
      const deleted = await call('DELETE', `/api/sites/${SITE_ID}/goals/${SIGNUP_ID}`, {
        cookie: owner,
      });
      expect(deleted.statusCode).toBe(200);
      const response = await call('GET', `${report}?funnel=${CHECKOUT_ID}&${range}`, {
        cookie: viewer,
      });
      expect(envelope<FunnelResult>(response.body).data?.steps.map((step) => step.visitors)).toEqual(
        [3, 2],
      );
    });
  });

  describe('the journeys report', () => {
    const report = `/api/sites/${SITE_ID}/stats/journeys`;

    it('follows each visit from its entry page and folds the rest of a column into Other', async () => {
      const response = await call('GET', `${report}?${range}&branches=1`, { cookie: viewer });
      expect(response.statusCode).toBe(200);
      const body = envelope<JourneyResult>(response.body);
      expect(body.data?.visits).toBe(3);
      expect(body.data?.branches).toBe(1);
      expect(body.data?.columns).toEqual([
        [
          { key: '/pricing', visits: 2, exits: 1, onward: 0 },
          { key: null, visits: 1, exits: 0, onward: 0 },
        ],
        [
          { key: '/docs', visits: 1, exits: 1, onward: 0 },
          { key: null, visits: 1, exits: 1, onward: 0 },
        ],
        [],
        [],
      ]);
      expect(body.data?.links).toEqual([
        { column: 0, from: '/pricing', to: '/docs', visits: 1 },
        { column: 0, from: null, to: null, visits: 1 },
      ]);
      expect(body.meta).toMatchObject({ rawOnly: true, retentionDays: 180 });
    });

    it('refuses a branch count no column can hold, and a goal', async () => {
      expectFailure(
        await call('GET', `${report}?${range}&branches=11`, { cookie: viewer }),
        400,
        'INVALID_QUERY',
      );
      expectFailure(
        await call('GET', `${report}?${range}&goal=${SIGNUP_ID}`, { cookie: viewer }),
        400,
        'UNSUPPORTED_GOAL',
      );
    });
  });

  describe('deleting', () => {
    it('deletes once, then says there is no such funnel', async () => {
      const url = `${funnels}/${CHECKOUT_ID}`;
      const first = await call('DELETE', url, { cookie: owner });
      expect(first.statusCode).toBe(200);
      expect(envelope<{ deleted: boolean }>(first.body).data).toEqual({ deleted: true });
      expectFailure(await call('DELETE', url, { cookie: owner }), 404, 'FUNNEL_NOT_FOUND');
      expectFailure(
        await call('GET', `/api/sites/${SITE_ID}/stats/funnel?funnel=${CHECKOUT_ID}&${range}`, {
          cookie: viewer,
        }),
        404,
        'FUNNEL_NOT_FOUND',
      );
    });
  });
});
