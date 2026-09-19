import { expect, test, type Page } from '@playwright/test';

// The walk somebody takes the first time they open this thing, in a real
// browser against the built files.
//
// The unit tests already assert what each page says. What only a browser can
// answer is whether the bundle boots at all, whether the router serves a deep
// link from a static tree, whether the fonts arrive, and whether a key pressed
// on a page that is really rendered does what the table says. Every one of
// those has shipped broken in a product whose component tests were green.

const SITE = 's_demo';

async function boot(page: Page, path = `/${SITE}`): Promise<void> {
  await page.goto(path);
  // The splash is on screen until GET /api/me answers, so waiting for a
  // heading is waiting for the whole boot rather than for a paint.
  await expect(page.getByRole('navigation', { name: 'Report' })).toBeVisible();
}

test('boots, and draws the overview with numbers in it', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(String(error)));

  await boot(page);

  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeAttached();
  await expect(page.getByText('15.2k')).toBeVisible();
  // The comparison is on by default, which is the second of the five rules.
  await expect(page.getByText('17%').first()).toBeVisible();
  expect(failures).toEqual([]);
});

test('serves a deep link from the static tree', async ({ page }) => {
  await boot(page, `/${SITE}/geo?range=30d`);
  await expect(page.getByRole('heading', { name: 'Geography', level: 1 })).toBeAttached();
  await expect(page.getByRole('region', { name: 'Visitors by country' })).toBeVisible();
  // The range survived the reload, because the URL is the state.
  await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('walks every report in the navigation', async ({ page }) => {
  await boot(page);
  for (const [label, heading] of [
    ['Realtime', 'Realtime'],
    ['Pages', 'Pages'],
    ['Sources', 'Sources'],
    ['Geo', 'Geography'],
    ['Devices', 'Devices'],
    ['People', 'People'],
  ] as const) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeAttached();
  }
});

test('filters the page from a row, and clears it again', async ({ page }) => {
  await boot(page, `/${SITE}/devices`);
  await page.getByRole('button', { name: /Mobile/ }).first().click();
  await expect(page).toHaveURL(/filters=/);
  // The filter is on screen as a chip, and removing it puts the page back.
  await page.getByRole('button', { name: /Remove this filter/ }).click();
  await expect(page).not.toHaveURL(/filters=/);
});

test('runs the keys on a page that is really rendered', async ({ page }) => {
  await boot(page);

  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(new RegExp(`/${SITE}/pages$`));

  await page.keyboard.press('t');
  await expect(page).toHaveURL(/range=today/);

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
});

test('carries the live report without a stream', async ({ page }) => {
  // The fixture serves no event stream, so this is the polled path: the page
  // has to say which of the two it is running rather than claiming to be live.
  await boot(page, `/${SITE}/realtime`);
  await expect(page.getByText(/Updating every \d+s/)).toBeVisible();
  await expect(page.getByRole('table', { name: /Everybody seen in the last half hour/ })).toBeVisible();
  await expect(page.getByText('Addresses are hidden. They need the read:identity permission.')).toBeVisible();
});

test('says what it cannot see rather than nothing', async ({ page }) => {
  await boot(page, `/${SITE}/pages`);
  const engagement = page.getByRole('region', { name: 'How far people read' });
  // A page nobody has closed yet has no number, and the row says so.
  await expect(engagement.getByText('not available').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Pages that were not found' })).toBeVisible();
});

test('serves its own fonts and nothing from anywhere else', async ({ page }) => {
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      outside.push(request.url());
    }
  });

  await boot(page);
  await page.waitForLoadState('networkidle');

  // An install that reaches out for a font tells somebody else's server who is
  // reading this dashboard, which is the thing this product exists not to do.
  expect(outside).toEqual([]);
  const fonts = await page.evaluate(() => document.fonts.size);
  expect(fonts).toBeGreaterThan(0);
});

test('reads on a phone without a sideways scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
