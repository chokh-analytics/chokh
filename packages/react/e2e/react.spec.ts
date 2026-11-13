import { expect, test, type Page } from '@playwright/test';

// The real a.js, booted by <ChokhProvider> in a React app under strict mode in a
// development build, where every effect runs twice. What reaches the collect
// path is what the tracker sent.

interface Event {
  type: string;
  path?: string;
  name?: string;
  props?: Record<string, string>;
}

async function events(page: Page): Promise<Event[]> {
  const response = await page.request.get('/__collected');
  const batches = (await response.json()) as { siteId: string; events: Event[] }[];
  for (const batch of batches) expect(batch.siteId).toBe('s_react');
  return batches.flatMap((batch) => batch.events);
}

async function pageviews(page: Page): Promise<(string | undefined)[]> {
  return (await events(page)).filter((event) => event.type === 'pageview').map((event) => event.path);
}

test.beforeEach(async ({ page }) => {
  await page.request.get('/__reset');
});

test('one pageview on load and one per client navigation, under strict mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect.poll(() => pageviews(page)).toEqual(['/']);

  await page.getByRole('button', { name: 'About' }).click();
  await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign up' }).click();

  await expect
    .poll(async () => (await events(page)).filter((event) => event.type === 'event'))
    .toEqual([expect.objectContaining({ name: 'signup', path: '/about', props: { plan: 'pro' } })]);
  // A batch leaves a second after its first event, so by now anything a second
  // copy of the tracker or a stray wrapper pageview would have sent has arrived.
  expect(await pageviews(page)).toEqual(['/', '/about']);

  expect(await page.locator('script#chokh-tracker').count()).toBe(1);
  expect(await page.locator('script[src="/a.js"]').count()).toBe(1);
  // The tracker booted and replaced the stub: nothing is left waiting.
  expect(await page.evaluate(() => (window as unknown as { pa?: { q?: unknown[] } }).pa?.q)).toBeUndefined();
});

test('with a consent prop, nothing leaves until consent is given, then the held pageview does', async ({ page }) => {
  await page.goto('/?consent');
  await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
  expect(await page.locator('script#chokh-tracker').getAttribute('data-consent')).toBe('');
  // Long enough for a batch to have left if one were going to.
  await page.waitForTimeout(1_500);
  expect(await events(page)).toEqual([]);

  await page.getByRole('button', { name: 'Accept' }).click();
  await expect.poll(() => pageviews(page)).toEqual(['/']);
});
