import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  NOW,
  SITE_ID,
  type Harness,
} from './api.test-utils.js';
import type { RealtimeSnapshot, StoredEvent } from '../store/AnalyticsStore.js';

// POST /api/sites/:siteId/events: what a backend sends with a write:events key.

describe('POST /api/sites/:siteId/events', () => {
  let harness: Harness;
  let key: string;

  beforeEach(async () => {
    harness = await createHarness();
    key = await harness.key(['write:events']);
  });

  afterEach(async () => {
    await harness.close();
  });

  function post(payload: unknown, headers: Record<string, string> = { authorization: key }) {
    return harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/events`,
      headers,
      payload: payload as Record<string, unknown>,
    });
  }

  it('accepts an event and says which visitor it landed on', async () => {
    const response = await post({
      userId: 'u_42',
      events: [{ type: 'event', name: 'order_paid', value: 1200 }],
    });

    expect(response.statusCode).toBe(202);
    const body = envelope<{ accepted: number; visitorId: string }>(response.body);
    expect(body.success).toBe(true);
    expect(body.data?.accepted).toBe(1);
    // Nobody has been here in a browser, so a synthetic id keeps them one visitor
    // rather than a new one per event.
    expect(body.data?.visitorId).toBe('u:u_42');
  });

  it('lands on the stay the browser is in the middle of', async () => {
    const pageview: StoredEvent = {
      siteId: SITE_ID,
      ts: NOW - 60_000,
      receivedAt: NOW - 60_000,
      type: 'pageview',
      visitorId: 'v_browser',
      userId: 'u_42',
      path: '/checkout',
      bot: false,
    };
    await harness.store.ingest([pageview]);

    const response = await post({
      userId: 'u_42',
      events: [{ type: 'event', name: 'order_paid' }],
    });
    expect(envelope<{ visitorId: string }>(response.body).data?.visitorId).toBe('v_browser');

    const stays = harness.store.sessionsOf(SITE_ID, 'v_browser');
    expect(stays).toHaveLength(1);
    expect(stays[0]?.events).toBe(1);
  });

  it('takes the browser visitor id when the application knows it', async () => {
    const response = await post({
      userId: 'u_42',
      visitorId: 'v_known',
      events: [{ type: 'event', name: 'order_paid' }],
    });
    expect(envelope<{ visitorId: string }>(response.body).data?.visitorId).toBe('v_known');
  });

  // A receipt written by a backend is not a sign that somebody is at a keyboard.
  it('puts nobody online', async () => {
    await post({ userId: 'u_42', events: [{ type: 'event', name: 'order_paid' }] });
    const realtime = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/realtime`,
      headers: { cookie: harness.owner.cookie },
    });
    expect(envelope<RealtimeSnapshot>(realtime.body).data?.online).toBe(0);
  });

  // A backend did not read a page, and counting one would put views in a report no
  // visitor performed.
  it('refuses a pageview and anything else a browser sends', async () => {
    expectFailure(
      await post({ userId: 'u_42', events: [{ type: 'pageview', path: '/' }] }),
      400,
      'INVALID_BATCH',
    );
    expectFailure(
      await post({ userId: 'u_42', events: [{ type: 'heartbeat' }] }),
      400,
      'INVALID_BATCH',
    );
  });

  it('refuses a batch with no userId, because there is nothing to join it to', async () => {
    expectFailure(await post({ events: [{ type: 'event', name: 'x' }] }), 400, 'INVALID_BATCH');
  });

  it('refuses an event with no name and a batch with no events', async () => {
    expectFailure(await post({ userId: 'u_42', events: [{ type: 'event' }] }), 400, 'INVALID_BATCH');
    expectFailure(await post({ userId: 'u_42', events: [] }), 400, 'INVALID_BATCH');
  });

  it('identifies somebody, traits and all, without a signature', async () => {
    const response = await post({
      userId: 'u_42',
      events: [{ type: 'identify', traits: { plan: 'pro' } }],
    });
    expect(response.statusCode).toBe(202);
    // A key presented by a server is the proof a browser identify needs a signature
    // for, so the identity is simply believed.
    const profile = await harness.store.user(SITE_ID, 'u_42');
    expect(profile?.traits).toEqual({ plan: 'pro' });
  });

  it('needs the write:events scope, whoever is asking', async () => {
    expectFailure(
      await post(
        { userId: 'u_42', events: [{ type: 'event', name: 'x' }] },
        { authorization: await harness.key(['read:stats']) },
      ),
      403,
      'SCOPE_REQUIRED',
    );
    const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
    expectFailure(
      await post({ userId: 'u_42', events: [{ type: 'event', name: 'x' }] }, { cookie: viewer.cookie }),
      403,
      'SCOPE_REQUIRED',
    );
    expectFailure(
      await post({ userId: 'u_42', events: [{ type: 'event', name: 'x' }] }, {}),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('refuses a key minted for another site', async () => {
    expectFailure(
      await post(
        { userId: 'u_42', events: [{ type: 'event', name: 'x' }] },
        { authorization: await harness.key(['write:events'], 's_elsewhere') },
      ),
      403,
      'SITE_FORBIDDEN',
    );
  });

  it('shows up in a report the way a browser event does', async () => {
    await post({
      userId: 'u_42',
      events: [{ type: 'event', name: 'order_paid', path: '/checkout' }],
    });
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/stats/breakdown?from=${NOW - 3_600_000}&to=${NOW + 1000}&dim=event`,
      headers: { cookie: harness.owner.cookie },
    });
    const rows = envelope<{ rows: { key: string; metrics: { visitors: number } }[] }>(response.body)
      .data?.rows;
    expect(rows?.[0]?.key).toBe('order_paid');
    expect(rows?.[0]?.metrics.visitors).toBe(1);
  });
});
