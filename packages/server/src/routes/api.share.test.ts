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
import { SHARE_COOKIE } from '../services/share.service.js';
import type { StoredEvent } from '../store/AnalyticsStore.js';

// The public share over HTTP (AN-RPT01): the owner makes a link, anybody with
// it reads the Overview's numbers and nothing about a person, a password
// stands in the way when the owner set one, and a new link or a new password
// ends every reader.

const TODAY_START = Date.UTC(2026, 8, 18);
const HOUR = 60 * 60 * 1000;

function pageview(visitorId: string, path: string, ts: number): StoredEvent {
  return {
    siteId: SITE_ID,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId,
    path,
    hostname: 'test.example',
    bot: false,
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country: 'BD', city: 'Dhaka' },
    lang: 'en',
  };
}

interface ShareView {
  share: { token: string; protected: boolean; createdAt: number };
}

describe('the public share', () => {
  let harness: Harness;
  let owner: string;
  let viewer: string;

  beforeAll(async () => {
    harness = await createHarness({ sites: [testSite()] });
    owner = harness.owner.cookie;
    viewer = (await harness.account({ email: 'viewer@test.example', role: 'viewer' })).cookie;
    await harness.store.ingest([
      pageview('v_1', '/pricing', NOW - HOUR),
      pageview('v_2', '/', NOW - 30 * 60_000),
    ]);
  });

  afterAll(async () => {
    await harness.close();
  });

  const range = `from=${TODAY_START}&to=${NOW}`;

  function put(payload: unknown, cookie: string = owner) {
    return harness.app.inject({
      method: 'PUT',
      url: `/api/sites/${SITE_ID}/share`,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });
  }

  function read(token: string, path = '', headers: Record<string, string> = {}) {
    return harness.app.inject({ method: 'GET', url: `/api/share/${token}${path}`, headers });
  }

  function shareCookie(response: { cookies: { name: string; value: string }[] }): string {
    const cookie = response.cookies.find((candidate) => candidate.name === SHARE_COOKIE);
    if (cookie === undefined) throw new Error('no share cookie was set');
    return `${cookie.name}=${cookie.value}`;
  }

  let token = '';

  it('is made by the owner and not by a viewer, and shows on the site without its hash', async () => {
    expectFailure(await put({}, viewer), 403, 'SCOPE_REQUIRED');
    const made = await put({});
    expect(made.statusCode).toBe(200);
    const share = envelope<ShareView>(made.body).data?.share;
    expect(share?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(share?.protected).toBe(false);
    token = share?.token ?? '';

    const site = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}`,
      headers: { cookie: viewer },
    });
    const view = envelope<{ site: { share?: Record<string, unknown> } }>(site.body).data?.site;
    expect(view?.share).toEqual({ token, protected: false, createdAt: expect.any(Number) });
    expect(JSON.stringify(view)).not.toContain('passwordHash');
  });

  it('answers whose numbers these are, and the reports, to anybody with the link and no cookie', async () => {
    const head = await read(token);
    expect(head.statusCode).toBe(200);
    expect(head.headers['x-robots-tag']).toBe('noindex');
    expect(envelope<unknown>(head.body).data).toEqual({
      site: { name: 'Test site', timezone: 'UTC' },
      protected: false,
      unlocked: true,
    });

    const totals = await read(token, `/stats/aggregate?${range}`);
    expect(totals.statusCode).toBe(200);
    expect(totals.headers['x-robots-tag']).toBe('noindex');
    expect(envelope<{ metrics: { visitors: number } }>(totals.body).data?.metrics.visitors).toBe(2);
    expect(envelope<unknown>(totals.body).meta).toMatchObject({ siteId: SITE_ID, timezone: 'UTC' });

    for (const path of [
      `/stats/timeseries?${range}&interval=hour`,
      `/stats/breakdown?${range}&dim=page`,
      `/stats/goals?${range}`,
      `/annotations?${range}`,
    ]) {
      const response = await read(token, path);
      expect(response.statusCode, path).toBe(200);
    }
    // The same rules as the report's own route: a backwards range is refused.
    expectFailure(await read(token, `/stats/aggregate?from=${NOW}&to=${TODAY_START}`), 400, 'INVALID_RANGE');
  });

  it('never reads a person: nothing about identity, people, realtime or events is under it', async () => {
    for (const path of [
      '/realtime',
      '/visitors/v_1',
      '/users/u_1',
      `/stats/events?${range}`,
      `/stats/properties?${range}&event=signup`,
      `/export.csv?${range}&dim=page`,
    ]) {
      expectFailure(await read(token, path), 404, 'NOT_FOUND');
    }
  });

  it('answers 404 for a link nobody made', async () => {
    expectFailure(await read('not-a-token'), 404, 'UNKNOWN_SHARE');
    expectFailure(await read('not-a-token', `/stats/aggregate?${range}`), 404, 'UNKNOWN_SHARE');
  });

  it('stands a password in the way, opens for the right one with a cookie, and refuses the wrong one', async () => {
    expectFailure(await put({ password: 'short' }), 400, 'INVALID_BODY');
    const locked = await put({ password: 'open-sesame' });
    expect(envelope<ShareView>(locked.body).data?.share).toMatchObject({ token, protected: true });

    const head = await read(token);
    expect(envelope<unknown>(head.body).data).toMatchObject({ protected: true, unlocked: false });
    expectFailure(await read(token, `/stats/aggregate?${range}`), 401, 'SHARE_LOCKED');

    const wrong = await harness.app.inject({
      method: 'POST',
      url: `/api/share/${token}/unlock`,
      payload: { password: 'open-please' },
    });
    expectFailure(wrong, 401, 'BAD_PASSWORD');

    const right = await harness.app.inject({
      method: 'POST',
      url: `/api/share/${token}/unlock`,
      payload: { password: 'open-sesame' },
    });
    expect(right.statusCode).toBe(200);
    const cookie = right.cookies.find((candidate) => candidate.name === SHARE_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe(`/api/share/${token}`);
    const jar = shareCookie(right);
    expect((await read(token, `/stats/aggregate?${range}`, { cookie: jar })).statusCode).toBe(200);
    expect(envelope<unknown>((await read(token, '', { cookie: jar })).body).data).toMatchObject({
      unlocked: true,
    });

    // A changed password ends the cookie; taking it off opens the share again.
    await put({ password: 'another-word' });
    expectFailure(await read(token, `/stats/aggregate?${range}`, { cookie: jar }), 401, 'SHARE_LOCKED');
    const open = await put({ password: null });
    expect(envelope<ShareView>(open.body).data?.share.protected).toBe(false);
    expect((await read(token, `/stats/aggregate?${range}`)).statusCode).toBe(200);
  });

  it('regenerates the link, which ends the old one, and deletes it', async () => {
    const again = await put({ regenerate: true });
    const fresh = envelope<ShareView>(again.body).data?.share.token ?? '';
    expect(fresh).not.toBe(token);
    expectFailure(await read(token), 404, 'UNKNOWN_SHARE');
    expect((await read(fresh)).statusCode).toBe(200);

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sites/${SITE_ID}/share`,
      headers: { cookie: owner },
    });
    expect(removed.statusCode).toBe(204);
    expectFailure(await read(fresh), 404, 'UNKNOWN_SHARE');
    const site = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}`,
      headers: { cookie: owner },
    });
    expect(envelope<{ site: { share?: unknown } }>(site.body).data?.site.share).toBeUndefined();
  });

  it('limits a reader by address, on a counter of its own', async () => {
    const made = await put({});
    const fresh = envelope<ShareView>(made.body).data?.share.token ?? '';
    let last = 200;
    for (let index = 0; index < 130 && last !== 429; index += 1) {
      last = (await read(fresh, `/stats/aggregate?${range}`, { 'x-forwarded-for': '203.0.113.9' }))
        .statusCode;
    }
    expect(last).toBe(429);
    // Signing in from the same address is another count.
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      payload: { email: 'nobody@test.example', password: 'whatever-it-is' },
    });
    expect(login.statusCode).toBe(401);
  });
});
