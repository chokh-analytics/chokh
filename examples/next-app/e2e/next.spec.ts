import { expect, test, type Page } from '@playwright/test';

// The App Router app wired with @chokh/next, built and started in production
// mode, against the real Chokh server. What is read back is what the collector
// stored: a page load and a client navigation through <Link> each count once,
// through the first-party script path and the signed collect route, with the
// visitor's address the route forwarded.

interface Row {
  type: string;
  path?: string;
  name?: string;
  ip?: string;
}

async function rows(page: Page): Promise<Row[]> {
  const response = await page.request.get('http://127.0.0.1:4116/');
  return (await response.json()) as Row[];
}

async function pageviews(page: Page): Promise<(string | undefined)[]> {
  return (await rows(page)).filter((row) => row.type === 'pageview').map((row) => row.path);
}

test.beforeEach(async ({ page }) => {
  await page.request.get('http://127.0.0.1:4116/reset');
});

test('a page load and a client navigation each store one pageview', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect.poll(() => pageviews(page), { timeout: 15_000 }).toEqual(['/']);

  await page.getByRole('link', { name: 'About' }).click();
  await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
  await expect.poll(() => pageviews(page), { timeout: 15_000 }).toEqual(['/', '/about']);

  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect
    .poll(async () => (await rows(page)).filter((row) => row.type === 'event').map((row) => row.name), {
      timeout: 15_000,
    })
    .toEqual(['signup']);
  // By now a doubled pageview from either navigation would have arrived.
  expect(await pageviews(page)).toEqual(['/', '/about', '/']);

  // The address the host saw, carried across by the route and signed.
  expect(new Set((await rows(page)).map((row) => row.ip))).toEqual(new Set(['203.0.113.9']));

  expect(await page.locator('script#chokh-tracker').count()).toBe(1);
  expect(await page.locator('script#chokh-tracker').getAttribute('src')).toBe('/_pa/a.js');
  expect(await page.locator('script#chokh-tracker').getAttribute('data-api')).toBe('/_pa');
  expect(await page.evaluate(() => (window as unknown as { pa?: { q?: unknown[] } }).pa?.q)).toBeUndefined();
});

test('the scripts are served from this origin through the rewrites', async ({ page }) => {
  for (const file of ['a.js', 'v.js', 'e.js']) {
    const response = await page.request.get(`/_pa/${file}`);
    expect(response.status(), file).toBe(200);
    expect(response.headers()['content-type'], file).toContain('javascript');
  }
});
