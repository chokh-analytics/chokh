import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The real signer and the real claim builder, so the token this suite presents
// is the one an application would mint rather than a hand rolled lookalike that
// can agree with a verifier they both got wrong.
import { signHs256 } from '@chokh/server/jwt';
import { ssoClaimsFor } from '@chokh/server/sso';

import { OWNER, SSO_SECRET } from './fixture-account.js';

// The walk somebody takes the first time they open this thing, in a real
// browser against the real server.
//
// The unit tests already assert what each page says. What only this can answer
// is whether the bundle boots at all, whether the router serves a deep link
// from the static host, whether the session cookie works, where an
// unauthenticated link lands, whether the stream carries a pageview that was
// posted a second ago, and what the page does when that stream dies. Every one
// of those is a seam between two packages, which is where every bug this
// product has shipped has been.

const SITE = 's_demo';
const ORIGIN = `http://127.0.0.1:${process.env.PORT ?? 4112}`;

async function boot(page: Page, path = `/${SITE}`): Promise<void> {
  await page.goto(path);
  // The splash is on screen until GET /api/me answers, so waiting for the
  // navigation waits for the whole boot rather than for a paint.
  await expect(page.getByRole('navigation', { name: 'Report' })).toBeVisible();
}

// One pageview, posted the way the tracker posts one.
//
// The Origin header is explicit because the collector refuses a batch whose
// origin is not a domain of the site, and Playwright's request context sends
// none of its own. A browser always sends it; this is the same request.
async function collect(request: APIRequestContext, visitorId: string): Promise<void> {
  const answer = await request.post('/api/collect', {
    headers: { 'content-type': 'text/plain', origin: ORIGIN },
    data: JSON.stringify({
      siteId: SITE,
      sentAt: Date.now(),
      hostname: '127.0.0.1',
      visitorId,
      lang: 'en',
      screen: '1440x900',
      events: [{ type: 'pageview', ts: Date.now(), path: '/pricing' }],
    }),
  });
  expect(answer.status(), 'the collector refused the batch').toBeLessThan(300);
}

function onlineCount(page: Page): Promise<number> {
  return page
    .getByRole('status')
    .first()
    .textContent()
    .then((text) => Number((text ?? '').replace(/[^0-9]/g, '')));
}

test('boots, and draws the overview with numbers in it', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(String(error)));

  await boot(page);

  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeAttached();
  // Seeded traffic, so the totals are numbers rather than the empty state.
  await expect(page.getByText('No data in this range.')).toHaveCount(0);
  const visitors = page
    .getByText('Visitors')
    .first()
    .locator('xpath=ancestor::*[contains(@class,"tile")][1]');
  await expect(visitors).not.toHaveText(/not available/);
  expect(failures).toEqual([]);
});

test('serves a deep link from the static host', async ({ page }) => {
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

test('says what it cannot see rather than nothing', async ({ page }) => {
  await boot(page, `/${SITE}/pages`);
  const engagement = page.getByRole('region', { name: 'How far people read' });
  // Seeded leaves carry a quartile, so this is the percentage a tracker sends.
  await expect(engagement.getByText(/^(25|50|75|100)%$/).first()).toBeVisible();
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

// A link somebody was sent, followed after a session expired. What matters is
// that the deep link survives the sign-in: landing on the Overview afterwards
// is the same as losing it.
test.describe('signed out', () => {
  // The only case that does not start from the shared session.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sends an unauthenticated deep link through sign in and back', async ({ page }) => {
    await page.goto(`/${SITE}/sources?range=30d`);

    await expect(page).toHaveURL(/\/login\?next=/);
    expect(decodeURIComponent(page.url())).toContain(`/${SITE}/sources?range=30d`);

    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(new RegExp(`/${SITE}/sources\\?range=30d$`));
    await expect(page.getByRole('heading', { name: 'Sources', level: 1 })).toBeAttached();
  });

  // Somebody presses "open the full dashboard" in another application's admin
  // panel and is simply already signed in here. That is a top level navigation
  // carrying a five minute token, a 303, a cookie set on the redirect and an
  // account provisioned on first arrival, and no per-package test sees any of
  // it: the service test never meets a browser, and the browser never meets the
  // service anywhere but here.
  test('signs a person in from another application and lands them on the report', async ({
    page,
  }) => {
    const token = signHs256(
      SSO_SECRET,
      ssoClaimsFor({
        sub: 'staff_7',
        email: 'staff@chokh.test',
        name: 'Staff Seven',
        role: 'viewer',
        now: Date.now(),
        lifetimeSeconds: 120,
      }),
    );

    await page.goto(`/api/sso?token=${encodeURIComponent(token)}&next=/${SITE}/sources`);

    await expect(page).toHaveURL(new RegExp(`/${SITE}/sources$`));
    await expect(page.getByRole('heading', { name: 'Sources', level: 1 })).toBeAttached();
    // Signed in as the person the token named, not as the fixture owner.
    const me = await page.request.get('/api/me');
    expect(me.ok(), 'the SSO session did not reach /api/me').toBe(true);
    expect(JSON.stringify(await me.json())).toContain('staff@chokh.test');

    // Single use. The same link read out of a history entry, a proxy log or a
    // Referer header and presented again is a token already burned, and the
    // refusal is one a person can read rather than an error object in the
    // address bar. The cookie goes first, because a browser that still has the
    // session never reaches the exchange: /login sends it straight back.
    await page.context().clearCookies();
    await page.goto(`/api/sso?token=${encodeURIComponent(token)}&next=/${SITE}/sources`);
    await expect(page).toHaveURL(/\/login\?sso=TOKEN_ALREADY_USED$/);
  });
});

// The stream, end to end: the collector writes presence, the bus wakes the
// stream, the frame reaches the page and the number moves. Nothing in a
// per-package test can say that sentence.
test('moves the online count over the stream within two seconds', async ({ page }) => {
  await boot(page, `/${SITE}/realtime`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  expect(await onlineCount(page)).toBe(0);

  const started = Date.now();
  await collect(page.request, `v_live_${started}`);

  await expect
    .poll(() => onlineCount(page), { timeout: 2_000, intervals: [100] })
    .toBeGreaterThan(0);
});

// A stream that dies has to say so. Drawn as "Live" with a frozen number, a
// dead stream is the most confident kind of wrong a live page can be.
test('falls back to polling when the stream dies, and keeps counting', async ({ page }) => {
  await page.route('**/realtime/stream', (route) => route.abort());
  await boot(page, `/${SITE}/realtime`);

  await expect(page.getByText(/Updating every \d+s/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Live', { exact: true })).toHaveCount(0);

  await collect(page.request, `v_polled_${Date.now()}`);
  await expect.poll(() => onlineCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
});

// A goal, end to end: a visitor sent by a search engine signs up, a goal asks
// about that signup, and the Sources report files the signup under the search
// that brought them rather than under the page it was sent from. The column is
// the server's same-day overlap drawn by the client, which no unit test on
// either side can say in one sentence. And the chart on the Overview still
// draws, because the client never forwards a goal to the time series, which the
// server refuses (AN-EVT01 ruling 4).
async function signupFromSearch(request: APIRequestContext, visitorId: string): Promise<void> {
  const now = Date.now();
  const answer = await request.post('/api/collect', {
    headers: { 'content-type': 'text/plain', origin: ORIGIN },
    data: JSON.stringify({
      siteId: SITE,
      sentAt: now,
      hostname: '127.0.0.1',
      visitorId,
      lang: 'en',
      screen: '1440x900',
      events: [
        { type: 'pageview', ts: now - 2_000, path: '/pricing', referrer: 'https://www.google.com/' },
        { type: 'event', ts: now - 1_000, path: '/pricing', name: 'e2e_signup', props: { plan: 'pro' } },
      ],
    }),
  });
  expect(answer.status(), 'the collector refused the batch').toBeLessThan(300);
}

async function goalFor(request: APIRequestContext, match: string): Promise<string> {
  const answer = await request.post(`/api/sites/${SITE}/goals`, {
    data: { name: 'Signed up in the suite', kind: 'event', match },
  });
  const body = (await answer.json()) as {
    data?: { goal: { id: string } };
    error?: { details?: { goalId?: string } };
  };
  // Created now, or by an earlier case of this same run: the id is derived from
  // the question, so the second ask names the goal that already answers it.
  const id = body.data?.goal.id ?? body.error?.details?.goalId;
  expect(id, `the goal was refused: ${JSON.stringify(body)}`).toBeTruthy();
  return id as string;
}

test('counts a goal on every breakdown, and never asks the chart for it', async ({ page }) => {
  await signupFromSearch(page.request, `v_goal_${Date.now()}`);
  const goal = await goalFor(page.request, 'e2e_signup');

  const series: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/stats/timeseries') || url.pathname.endsWith('/stats/engagement')) {
      series.push(url.search);
    }
  });

  await boot(page, `/${SITE}/sources?range=today&goal=${goal}`);
  const channels = page.getByRole('region', { name: 'Channels' });
  await expect(channels.getByRole('columnheader', { name: 'Conversion rate' })).toBeVisible();
  const organic = channels.getByRole('row').filter({ hasText: 'Organic search' });
  await expect(organic.locator('td').last()).toHaveAttribute('title', /^[1-9][\d,]* converted$/);
  await expect(page.getByText('Goal: Signed up in the suite')).toBeVisible();

  await page.goto(`/${SITE}?range=today&goal=${goal}`);
  const chart = page.locator('table', { hasText: 'The numbers behind the chart above.' });
  await expect.poll(() => chart.locator('tbody tr').count()).toBeGreaterThan(0);
  await expect(
    page.getByRole('region', { name: 'Sources' }).getByRole('columnheader', { name: 'Conversion rate' }),
  ).toBeAttached();

  await page.goto(`/${SITE}/pages?range=today&goal=${goal}`);
  await expect(page.getByRole('region', { name: 'How far people read' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(series.length).toBeGreaterThan(0);
  expect(series.filter((search) => search.includes('goal='))).toEqual([]);
});
