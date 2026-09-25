import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  expectFailure,
  NOW,
  SITE_ID,
  testSite,
  type Harness,
} from './api.test-utils.js';
import { funnelIdFor, goalIdFor, type StoredEvent } from '../store/AnalyticsStore.js';

// Every report as a file, over HTTP (AN-RPT01).
//
// The site is in UTC. Today v_1 reads /pricing, signs up on the pro plan and
// leaves the page after a minute; v_2 reads two pages and does not. Yesterday,
// rolled up, v_3 signs up on the free plan. One goal and one funnel are
// created through their own routes, so what the export reads is what the
// pages read.

const TODAY_START = Date.UTC(2026, 8, 18);
const YESTERDAY_START = Date.UTC(2026, 8, 17);
const HOUR = 60 * 60 * 1000;
const SIGNUP_ID = goalIdFor(SITE_ID, 'event', 'signup');
const CHECKOUT_ID = funnelIdFor(SITE_ID, '1d', [
  { kind: 'page', match: '/pricing' },
  { kind: 'event', match: 'signup' },
]);

function row(visitorId: string, ts: number, over: Partial<StoredEvent>, country: 'BD' | 'IN'): StoredEvent {
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

describe('the CSV export of every report', () => {
  let harness: Harness;
  let owner: string;
  let viewer: string;

  beforeAll(async () => {
    harness = await createHarness({ sites: [testSite()] });
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
      row('v_1', NOW - 54 * 60_000, { type: 'leave', path: '/pricing', duration: 62_000, scrollDepth: 75 }, 'BD'),
      row('v_2', NOW - 30 * 60_000, { path: '/pricing' }, 'IN'),
      row('v_2', NOW - 29 * 60_000, { path: '/' }, 'IN'),
    ]);

    const goal = await harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/goals`,
      headers: { cookie: owner },
      payload: { name: 'Signed up', kind: 'event', match: 'signup', value: 5 },
    });
    expect(goal.statusCode).toBe(201);
    const funnel = await harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/funnels`,
      headers: { cookie: owner },
      payload: {
        name: 'Checkout',
        window: '1d',
        steps: [{ page: '/pricing', name: 'Pricing' }, { goalId: SIGNUP_ID, name: 'Signed up' }],
      },
    });
    expect(funnel.statusCode).toBe(201);
  });

  afterAll(async () => {
    await harness.close();
  });

  const range = `from=${YESTERDAY_START}&to=${NOW}`;

  function exportCsv(query: string, cookie: string = viewer) {
    return harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/export.csv?${query}`,
      headers: { cookie },
    });
  }

  function lines(body: string): string[] {
    return body.trimEnd().split('\r\n');
  }

  it('answers a breakdown when no report is named, exactly as before', async () => {
    const response = await exportCsv(`${range}&dim=country`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="${SITE_ID}-breakdown-country-2026-09-17-2026-09-18.csv"`,
    );
    const rows = lines(response.body);
    expect(rows[0]).toBe('key,visitors,pageviews,visits,bounces,bounce_rate,avg_duration_ms');
    expect(rows.find((line) => line.startsWith('BD,'))?.startsWith('BD,2,')).toBe(true);
  });

  it('exports a timeseries with the compared series after the current one', async () => {
    const response = await exportCsv(
      `report=timeseries&from=${TODAY_START}&to=${NOW}&interval=day&compare=previous_period`,
    );
    expect(response.statusCode).toBe(200);
    const rows = lines(response.body);
    expect(rows[0]).toBe(
      'series,start,end,visitors,pageviews,visits,bounces,bounce_rate,avg_duration_ms',
    );
    expect(rows[1]?.startsWith('current,2026-09-18T00:00:00.000Z,')).toBe(true);
    expect(rows.some((line) => line.startsWith('previous,2026-09-17T00:00:00.000Z,'))).toBe(true);
  });

  it('exports engagement, events, properties, goals, the funnel and the journeys', async () => {
    const engagement = await exportCsv(`report=engagement&${range}&dim=page`);
    expect(lines(engagement.body)).toEqual([
      'key,avg_time_on_page_ms,avg_scroll_depth,leaves',
      '/pricing,62000,75,1',
    ]);

    const events = await exportCsv(`report=events&${range}`);
    expect(lines(events.body)).toEqual(['key,visitors,events,rate', `signup,2,2,${2 / 3}`]);

    const properties = await exportCsv(`report=properties&${range}&event=signup`);
    const propertyRows = lines(properties.body);
    expect(propertyRows[0]).toBe('event,property,key,visitors,events,rate');
    // The rate is over the range's three visitors, as the JSON answers it.
    expect(propertyRows.slice(1).sort()).toEqual([
      `signup,plan,free,1,1,${1 / 3}`,
      `signup,plan,pro,1,1,${1 / 3}`,
    ]);

    const goals = await exportCsv(`report=goals&${range}`);
    expect(lines(goals.body)).toEqual([
      'goal_id,goal,converted_visitors,completions,conversion_rate,value',
      `${SIGNUP_ID},Signed up,2,2,${2 / 3},10`,
    ]);

    const funnel = await exportCsv(`report=funnel&${range}&funnel=${CHECKOUT_ID}`);
    expect(funnel.statusCode).toBe(200);
    const funnelRows = lines(funnel.body);
    expect(funnelRows[0]).toBe('step,name,visitors,drop_off,rate,step_rate');
    expect(funnelRows[1]?.startsWith('1,Pricing,')).toBe(true);
    expect(funnelRows[2]?.startsWith('2,Signed up,')).toBe(true);
    expect(funnel.headers['content-disposition']).toContain(`${SITE_ID}-funnel-${CHECKOUT_ID}-`);

    const journeys = await exportCsv(`report=journeys&${range}`);
    expect(journeys.statusCode).toBe(200);
    expect(lines(journeys.body)[0]).toBe('column,from,to,visits');
    expect(lines(journeys.body)).toContain('0,/pricing,/,1');
  });

  it('refuses a kind it does not have, and each report what its route refuses', async () => {
    expectFailure(await exportCsv(`report=people&${range}`), 400, 'INVALID_QUERY');
    expectFailure(await exportCsv(`report=properties&${range}`), 400, 'MISSING_EVENT');
    expectFailure(await exportCsv(`report=funnel&${range}`), 400, 'MISSING_FUNNEL');
    expectFailure(await exportCsv(`report=funnel&${range}&funnel=f_nope`), 404, 'FUNNEL_NOT_FOUND');
    expectFailure(await exportCsv(`report=goals&${range}&goal=${SIGNUP_ID}`), 400, 'UNSUPPORTED_GOAL');
    expectFailure(await exportCsv(`report=journeys&${range}&goal=${SIGNUP_ID}`), 400, 'UNSUPPORTED_GOAL');
    expectFailure(await exportCsv(`report=timeseries&from=${NOW}&to=${TODAY_START}`), 400, 'INVALID_RANGE');
  });

  it('is read:stats, so a viewer exports and nobody does not', async () => {
    const anonymous = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/export.csv?report=events&${range}`,
    });
    expectFailure(anonymous, 401, 'UNAUTHENTICATED');
    const wrongScope = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/export.csv?report=events&${range}`,
      headers: { authorization: await harness.key(['write:events']) },
    });
    expect(wrongScope.statusCode).toBe(403);
  });
});
