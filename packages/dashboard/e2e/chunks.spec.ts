import { expect, test, type Page } from '@playwright/test';

// What a first paint actually downloads.
//
// This is the one claim about code splitting that a unit test cannot make.
// `lazy(` in the source says an import is dynamic; only a browser says whether
// the world map reached the sign-in screen, and that is the number a developer
// deciding whether to install this feels first.

const SITE = 's_demo';

function scripts(page: Page): { seen: string[] } {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') {
      seen.push(new URL(request.url()).pathname);
    }
  });
  return { seen };
}

const isMap = (path: string): boolean => /\/map-.*\.js$/.test(path);

test('never downloads the world map for a page that has no map on it', async ({ page }) => {
  const { seen } = scripts(page);

  await page.goto(`/${SITE}`);
  await expect(page.getByRole('navigation', { name: 'Report' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Forty kilobytes of coastline, on the page every visit starts on.
  expect(seen.filter(isMap), `the map loaded on the Overview: ${seen.join(', ')}`).toEqual([]);

  await page.getByRole('link', { name: 'Pages', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pages', level: 1 })).toBeAttached();
  expect(seen.filter(isMap)).toEqual([]);
});

test('downloads it once, on the first report that draws one', async ({ page }) => {
  const { seen } = scripts(page);

  await page.goto(`/${SITE}/geo`);
  await expect(page.getByRole('region', { name: 'Visitors by country' })).toBeVisible();
  expect(seen.filter(isMap)).toHaveLength(1);

  // Realtime draws the same outlines. One file, so the second report that
  // wants it pays nothing.
  await page.getByRole('link', { name: 'Realtime', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Realtime', level: 1 })).toBeAttached();
  await page.waitForLoadState('networkidle');
  expect(seen.filter(isMap)).toHaveLength(1);
});

test('loads a report as its own file, when it is opened', async ({ page }) => {
  const { seen } = scripts(page);

  await page.goto(`/${SITE}`);
  await expect(page.getByRole('navigation', { name: 'Report' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const atFirstPaint = seen.length;

  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeAttached();

  // A report that arrives with the entry chunk is a report everybody pays for.
  expect(seen.length).toBeGreaterThan(atFirstPaint);
  expect(seen.some((path) => /\/People-.*\.js$/.test(path))).toBe(true);
});
