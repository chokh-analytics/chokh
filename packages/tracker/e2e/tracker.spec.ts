import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { Batch, TrackedEvent } from '../src/types';

async function batches(request: APIRequestContext): Promise<Batch[]> {
  const response = await request.get('/__collected');
  return (await response.json()) as Batch[];
}

async function events(request: APIRequestContext): Promise<TrackedEvent[]> {
  return (await batches(request)).flatMap((batch) => batch.events);
}

function named(list: TrackedEvent[], name: string): TrackedEvent | undefined {
  return list.find((event) => event.name === name);
}

test.beforeEach(async ({ request }) => {
  await request.post('/__reset');
});

test('a page load collects one pageview with the page context', async ({ page, request }) => {
  await page.goto('/');

  await expect.poll(async () => (await events(request)).length).toBeGreaterThan(0);

  const collected = await batches(request);
  const batch = collected[0];
  expect(batch?.siteId).toBe('fixture_site');
  expect(batch?.hostname).toBe('127.0.0.1');
  expect(batch?.visitorId).toBeTruthy();
  expect(batch?.screen).toMatch(/^\d+x\d+$/);
  expect(batch?.viewport).toMatch(/^\d+x\d+$/);

  const pageview = batch?.events[0];
  expect(pageview?.type).toBe('pageview');
  expect(pageview?.path).toBe('/');
  expect(pageview?.title).toBe('Chokh tracker fixture');
});

test('a campaign link carries its utm parameters', async ({ page, request }) => {
  await page.goto('/?utm_source=facebook&utm_medium=social&utm_campaign=imupc');

  await expect.poll(async () => (await events(request)).length).toBeGreaterThan(0);

  const pageview = (await events(request))[0];
  expect(pageview?.path).toBe('/');
  expect(pageview?.utm).toEqual({
    source: 'facebook',
    medium: 'social',
    campaign: 'imupc',
  });
});

test('clicks, custom events and identify reach the collector', async ({ page, request }) => {
  await page.goto('/');

  await page.click('#marked span');
  await page.click('#outbound');
  await page.click('#download');
  await page.click('#custom');
  await page.click('#identify');

  await expect
    .poll(async () => (await events(request)).filter((e) => e.type === 'identify').length)
    .toBe(1);

  const collected = await events(request);

  expect(named(collected, 'cta_click')?.props).toEqual({ plan: 'pro' });
  expect(named(collected, 'outbound_link')?.props).toEqual({
    url: 'https://elsewhere.test/pricing',
  });
  expect(named(collected, 'file_download')?.props).toEqual({
    url: 'http://127.0.0.1:4111/files/report.pdf',
  });
  expect(named(collected, 'quiz_start')?.props).toEqual({ quizId: 'q1' });

  const identify = collected.find((event) => event.type === 'identify');
  expect(identify?.userId).toBe('user_42');
  expect(identify?.traits).toEqual({ plan: 'pro' });

  const withUser = (await batches(request)).find((batch) => batch.userId !== undefined);
  expect(withUser?.userId).toBe('user_42');
});

test('a single page navigation collects a second pageview', async ({ page, request }) => {
  await page.goto('/');
  await page.click('#navigate');

  await expect
    .poll(async () => (await events(request)).filter((e) => e.type === 'pageview').length)
    .toBe(2);

  const paths = (await events(request))
    .filter((event) => event.type === 'pageview')
    .map((event) => event.path);
  expect(paths).toEqual(['/', '/courses/cp-beginners']);
});

test('leaving the page sends a leave beacon with time on page and scroll depth', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.waitForTimeout(150);
  await page.goto('about:blank');

  await expect
    .poll(async () => (await events(request)).filter((e) => e.type === 'leave').length)
    .toBe(1);

  const leave = (await events(request)).find((event) => event.type === 'leave');
  expect(leave?.path).toBe('/');
  expect(leave?.duration).toBeGreaterThan(0);
  expect(typeof leave?.scrollDepth).toBe('number');
});
