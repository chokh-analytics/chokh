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
    ['Events', 'Events'],
    ['Goals', 'Goals'],
    ['Funnels', 'Funnels'],
    ['People', 'People'],
    ['Alerts', 'Alerts'],
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
  // Seeded leaves carry a quartile, so every row is an average of quartiles:
  // a percentage from 25 to 100, never the hundredfold one a rate formatter
  // printed. Not an exact quartile, which a row is only when its leaves agree,
  // and which of them do moves with the hour the suite runs at.
  const depth = engagement.getByText(/^\d{1,3}%$/).first();
  await expect(depth).toBeVisible();
  const percent = Number((await depth.textContent())?.replace('%', ''));
  expect(percent).toBeGreaterThanOrEqual(25);
  expect(percent).toBeLessThanOrEqual(100);
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

// Ten destinations fit neither in 390 pixels nor beside the mark and the
// account at 1024, so they are one row that scrolls sideways inside the bar.
// On a phone the bar is two rows, the mark and the account over the
// destinations; at 1024 it is one row, destinations included, because a bar
// that wrapped put the account on a row of its own under a range bar stuck at
// the one row height. Either way the page somebody is on is scrolled into the
// row rather than left past its edge, and the page itself never moves sideways.
test('keeps eleven destinations in one row at 390 and at 1024, with the current one in view', async ({
  page,
}) => {
  // A goal in the list first. The Goals page with nothing in it is one
  // sentence wide, which is why this case once passed over a table that pushed
  // the page 71 px sideways the moment it had a row.
  const created = await page.request.post(`/api/sites/${SITE}/goals`, {
    data: { name: 'Read the pricing page on a phone', kind: 'page', match: '/pricing' },
  });
  const body = (await created.json()) as {
    data?: { goal: { id: string } };
    error?: { details?: { goalId?: string } };
  };
  const goalId = body.data?.goal.id ?? body.error?.details?.goalId;
  expect(goalId, `the goal was refused: ${JSON.stringify(body)}`).toBeTruthy();

  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    // Alerts first: it has no range bar, and the range bar is measured on
    // whichever page the loop ends on.
    for (const [path, label] of [
      ['alerts', 'Alerts'],
      ['goals', 'Goals'],
      ['funnels', 'Funnels'],
      ['people', 'People'],
      ['events', 'Events'],
    ] as const) {
      await boot(page, `/${SITE}/${path}`);
      if (path === 'goals') {
        // The row is drawn, so the overflow below is measured over a real list.
        await expect(
          page.getByRole('button', { name: 'Read the pricing page on a phone' }),
        ).toBeVisible();
      }
      if (path === 'funnels') {
        // The seeded funnel drawn, and the builder opened out to three steps,
        // so the overflow is measured over the widest this page gets.
        await expect(page.getByRole('button', { name: 'Home to pricing' })).toBeVisible();
        await expect(
          page.getByRole('list', { name: 'How far people got through Home to pricing' }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Add a step' }).click();
        await expect(page.getByRole('group', { name: 'Step 3' })).toBeVisible();
      }
      const nav = page.getByRole('navigation', { name: 'Report' });
      const row = await nav.boundingBox();
      const current = await nav.getByRole('link', { name: label, exact: true }).boundingBox();
      const mark = await page.getByRole('link', { name: 'Chokh', exact: true }).boundingBox();
      const bar = await page.locator('header').first().boundingBox();
      expect(row, 'the navigation has no box').not.toBeNull();
      expect(current, `${label} has no box`).not.toBeNull();
      expect(mark, 'the mark has no box').not.toBeNull();
      expect(bar, 'the bar has no box').not.toBeNull();
      if (row === null || current === null || mark === null || bar === null) {
        return;
      }
      // One row of links, not a wrapped block of them.
      expect(row.height, `the destinations wrapped at ${width}`).toBeLessThan(current.height * 2);
      expect(current.x).toBeGreaterThanOrEqual(row.x - 1);
      expect(current.x + current.width).toBeLessThanOrEqual(row.x + row.width + 1);
      if (width === 390) {
        // Two rows: the destinations under the mark, and nothing on a third.
        expect(row.y).toBeGreaterThanOrEqual(mark.y + mark.height - 1);
        expect(bar.height).toBeLessThan(mark.height + row.height + 48);
      } else {
        // One row: the destinations beside the mark, and a bar one row tall.
        expect(Math.abs(row.y + row.height / 2 - (mark.y + mark.height / 2))).toBeLessThan(4);
        expect(bar.height, `the bar wrapped at ${width}`).toBeLessThan(current.height * 2);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `/${path} scrolls sideways at ${width}`).toBeLessThanOrEqual(0);
      if (path === 'goals' && width === 390) {
        // And the columns are a scroll away inside the card rather than gone.
        const inner = await page
          .getByRole('group', { name: 'Goals' })
          .evaluate((box) => box.scrollWidth - box.clientWidth);
        expect(inner, 'the goal list dropped its columns rather than scrolling them').toBeGreaterThan(0);
      }
    }

    if (width === 390) {
      // And the range bar stays two rows with the goal control in it: the goal
      // and the zone share the second row rather than the zone falling to a
      // third.
      const goal = await page.getByRole('button', { name: 'Goal', exact: true }).boundingBox();
      const zone = await page.getByText('Asia/Dhaka', { exact: true }).boundingBox();
      expect(goal).not.toBeNull();
      expect(zone).not.toBeNull();
      if (goal !== null && zone !== null) {
        expect(Math.abs(goal.y + goal.height / 2 - (zone.y + zone.height / 2))).toBeLessThan(
          goal.height,
        );
      }
    }
  }

  // Left as it was found, so no later case counts this goal.
  const removed = await page.request.delete(`/api/sites/${SITE}/goals/${goalId as string}`);
  expect(removed.ok()).toBe(true);
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

// A goal made the way a person makes one: on the Goals page, with the form,
// and chosen by pressing its name. Against a server this run started it is
// created here; against one reused while the suite is being written it may
// already exist, and the page says so in words, which is its own proof.
async function goalFromThePage(page: Page, match: string): Promise<string> {
  await boot(page, `/${SITE}/goals?range=today`);
  const form = page.getByRole('region', { name: 'Add a goal' });
  await form.getByLabel('Name', { exact: true }).fill('Signed up in the suite');
  await form.getByLabel('Event name').fill(match);
  await form.getByRole('button', { name: 'Add the goal' }).click();

  const list = page.getByRole('region', { name: 'Goals', exact: true });
  const created = list.getByRole('button', { name: 'Signed up in the suite' });
  await expect(created.or(form.getByText('A goal for that already exists.'))).toBeVisible();
  await expect(created).toBeVisible();
  await created.click();
  await expect(page).toHaveURL(/goal=g_/);
  const goal = new URL(page.url()).searchParams.get('goal');
  expect(goal).toBeTruthy();
  return goal as string;
}

test('counts a goal on every breakdown, and never asks the chart for it', async ({ page }) => {
  await signupFromSearch(page.request, `v_goal_${Date.now()}`);

  const series: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/stats/timeseries') || url.pathname.endsWith('/stats/engagement')) {
      series.push(url.search);
    }
  });

  const goal = await goalFromThePage(page, 'e2e_signup');
  // Chosen on the Goals page, and the Goals page says what it counted.
  await expect(
    page
      .getByRole('region', { name: 'Goals', exact: true })
      .getByRole('row')
      .filter({ hasText: 'Signed up in the suite' }),
  ).toContainText(/[1-9]/);

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

  // Deleted, and the numbers leave with it: the link loses the goal and the
  // column goes. Nothing is lost, which is what the confirmation promised.
  await page.goto(`/${SITE}/goals?range=today&goal=${goal}`);
  const row = page
    .getByRole('region', { name: 'Goals', exact: true })
    .getByRole('row')
    .filter({ hasText: 'Signed up in the suite' });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/Nothing is lost/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete it' }).click();
  await expect(page).not.toHaveURL(/goal=/);
  await expect(row).toHaveCount(0);

  await page.goto(`/${SITE}/sources?range=today&goal=${goal}`);
  await expect(page.getByText('That goal no longer exists.')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Channels' }).getByRole('columnheader', { name: 'Bounce rate' }),
  ).toBeAttached();
  await expect(page.getByRole('columnheader', { name: 'Conversion rate' })).toHaveCount(0);
});

// The events report over a batch this case posted itself: the event is listed
// by name, choosing it filters the page, and the card under it breaks it down
// by the property it carried, read with the property's own name.
test('lists an event and breaks it down by what it carried', async ({ page }) => {
  await signupFromSearch(page.request, `v_events_${Date.now()}`);

  await boot(page, `/${SITE}/events?range=today`);
  const events = page.getByRole('region', { name: 'Events', exact: true });
  await events.getByRole('button', { name: /e2e_signup/ }).click();
  await expect(page).toHaveURL(/filters=event/);

  const properties = page.getByRole('region', { name: 'Properties of e2e_signup' });
  await expect(properties.getByRole('tab', { name: 'plan' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(properties.getByRole('row').filter({ hasText: 'pro' })).toBeVisible();
  await expect(properties.getByText('A property cannot be used as a filter yet.')).toBeVisible();
});

// Somebody on the site, read on a phone. The visitor table is six columns with
// an address among them for an owner, which is wider than 390 pixels: it
// scrolls inside its card, and the page itself never moves sideways. The phone
// case above reads the Overview with nobody online, which is why this went
// unseen until a table had a row in it.
test('keeps the visitor table inside a phone screen once somebody is here', async ({ page }) => {
  await collect(page.request, `v_phone_${Date.now()}`);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const path of ['people', 'realtime']) {
    await boot(page, `/${SITE}/${path}`);
    const table = page.getByRole('group', { name: 'Everybody seen in the last half hour.' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    // The columns past the edge are still there, a scroll away inside the card.
    const inner = await table.evaluate((box) => box.scrollWidth - box.clientWidth);
    expect(inner, `${path} lost its columns rather than scrolling them`).toBeGreaterThan(0);
  }
});

// A funnel made the way a person makes one: on the Funnels page, from a goal
// and a typed path, chosen into the link the moment it exists, read drawn over
// a visitor this case sent through it, and deleted with the confirmation that
// says nothing is lost. The goal is made over HTTP first because the goal form
// has its own case; this one is about the builder and the drawing.
test('builds a funnel from a goal and a path, reads it drawn, and deletes it', async ({
  page,
}) => {
  // One person who read the pricing page and then signed up, as a tracker
  // sends it, so the drawing has somebody at both steps.
  const now = Date.now();
  const sent = await page.request.post('/api/collect', {
    headers: { 'content-type': 'text/plain', origin: ORIGIN },
    data: JSON.stringify({
      siteId: SITE,
      sentAt: now,
      hostname: '127.0.0.1',
      visitorId: `v_funnel_${now}`,
      lang: 'en',
      screen: '1440x900',
      events: [
        { type: 'pageview', ts: now - 2_000, path: '/pricing' },
        { type: 'event', ts: now - 1_000, path: '/pricing', name: 'e2e_funnel_signup' },
      ],
    }),
  });
  expect(sent.status(), 'the collector refused the batch').toBeLessThan(300);

  const created = await page.request.post(`/api/sites/${SITE}/goals`, {
    data: { name: 'Signed up in the funnel case', kind: 'event', match: 'e2e_funnel_signup' },
  });
  const body = (await created.json()) as {
    data?: { goal: { id: string } };
    error?: { details?: { goalId?: string } };
  };
  const goalId = body.data?.goal.id ?? body.error?.details?.goalId;
  expect(goalId, `the goal was refused: ${JSON.stringify(body)}`).toBeTruthy();

  await boot(page, `/${SITE}/funnels?range=today`);
  const builder = page.getByRole('region', { name: 'Add a funnel' });
  await builder.getByLabel('Name', { exact: true }).fill('Pricing then signup in the suite');
  const first = builder.getByRole('group', { name: 'Step 1' });
  await first.getByLabel('Page path').fill('/pricing');
  const second = builder.getByRole('group', { name: 'Step 2' });
  await second.getByLabel('Counts when').selectOption('goal');
  await second
    .getByLabel('Goal', { exact: true })
    .selectOption({ label: 'Signed up in the funnel case' });
  await builder.getByRole('button', { name: 'Add the funnel' }).click();

  // Chosen into the link, and pressed in the list.
  await expect(page).toHaveURL(/funnel=f_/);
  const list = page.getByRole('region', { name: 'Funnels', exact: true });
  const made = list.getByRole('button', { name: 'Pricing then signup in the suite' });
  await expect(made).toHaveAttribute('aria-pressed', 'true');
  await expect(
    list.getByRole('list', { name: 'Steps of Pricing then signup in the suite' }),
  ).toHaveText(/\/pricing.*Signed up in the funnel case/);

  // Drawn: the person this case sent reached both steps, with the notes under it.
  const drawn = page.getByRole('region', { name: 'Pricing then signup in the suite' });
  const steps = drawn.getByRole('list', {
    name: 'How far people got through Pricing then signup in the suite',
  });
  await expect(steps.getByRole('listitem')).toHaveCount(2);
  await expect(steps.getByRole('listitem').nth(1)).toContainText('Signed up in the funnel case');
  await expect(steps.getByRole('listitem').nth(1).locator('[title]')).toHaveText(
    /^[1-9][\d,]*$/,
  );
  await expect(drawn.getByText(/visitors started it\./)).toBeVisible();
  await expect(drawn.getByText('Every step within 7 days of the first.')).toBeVisible();
  await expect(drawn.getByText(/Counted once per person over the whole range/)).toBeVisible();

  // Deleted, and the link stops naming it.
  const item = list
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Pricing then signup in the suite' }) });
  await item.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(item.getByText(/Nothing is lost/)).toBeVisible();
  await item.getByRole('button', { name: 'Delete it' }).click();
  await expect(made).toHaveCount(0);
  await expect(page).not.toHaveURL(/funnel=/);
  await expect(page).toHaveURL(/range=today/);

  const removed = await page.request.delete(`/api/sites/${SITE}/goals/${goalId as string}`);
  expect(removed.ok()).toBe(true);
});

// Journeys on a phone, over the walks the server seeds: the flow keeps a width
// a path can be read at and scrolls inside its card, the page never moves
// sideways, a node filters the report without closing the tab, and the branch
// count is kept in the link.
test('draws journeys on a phone inside their card, and filters from a node', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/${SITE}/pages?pages=journeys`);

  const box = page.getByRole('group', {
    name: 'The paths visits took, from the page they came in on',
  });
  const pricing = box.getByRole('button', { name: /^\/pricing / }).first();
  await expect(box.getByText('4th page')).toBeVisible();
  await expect(pricing).toBeAttached();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'Journeys scrolls the page sideways').toBeLessThanOrEqual(0);
  const inner = await box.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(inner, 'the flow was squeezed rather than scrolled').toBeGreaterThan(0);
  await expect(box).toHaveAttribute('tabindex', '0');

  await page.getByLabel('Pages per step').selectOption('3');
  await expect(page).toHaveURL(/branches=3/);

  await pricing.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('filters'))
    .toBe('page==/pricing');
  await expect(page).toHaveURL(/pages=journeys/);
  await expect(page).toHaveURL(/branches=3/);
  await expect(pricing).toHaveAttribute('aria-pressed', 'true');
});

// The settings page, the Routes tab and the segments, over the real server.
//
// A rule saved here is stamped on the next pageview collected, so the Routes
// tab shows the folded row over pageviews posted after the save; the regroup
// of history is the jobs' work and is proved in the store suites. The site is
// put back as it was at the end, because the audit and the screenshots run
// against the same seeded install.
test('saves an exclusion and a route rule, then reads the folded row on the Routes tab', async ({
  page,
}) => {
  await boot(page, `/${SITE}/settings`);
  await expect(page.getByRole('heading', { name: 'Settings for Progsity', level: 1 })).toBeVisible();

  const exclusions = page.getByRole('region', { name: 'Keep your own traffic out' });
  await exclusions.getByLabel('Paths').fill('/preview/*');
  await exclusions.getByRole('button', { name: 'Save' }).click();
  await expect(exclusions.getByRole('status')).toHaveText('Saved.');

  const routes = page.getByRole('region', { name: 'Route groups' });
  await routes.getByLabel('Rules').fill('/courses/:slug');
  await routes.getByRole('button', { name: 'Save' }).click();
  await expect(routes.getByRole('status')).toHaveText('Saved.');
  await expect(routes.getByText(/regrouped on the next hourly pass/)).toBeVisible();

  // Two courses read now, and one preview page that must not count.
  const now = Date.now();
  for (const [index, path] of ['/courses/a', '/courses/b', '/preview/draft-1'].entries()) {
    const sent = await page.request.post('/api/collect', {
      headers: { 'content-type': 'text/plain', origin: ORIGIN },
      data: JSON.stringify({
        siteId: SITE,
        sentAt: now,
        hostname: '127.0.0.1',
        visitorId: `v_routes_${now}_${index}`,
        lang: 'en',
        screen: '1440x900',
        events: [{ type: 'pageview', ts: now - 1_000 + index, path }],
      }),
    });
    expect(sent.status(), 'the collector refused the batch').toBeLessThan(300);
  }

  await boot(page, `/${SITE}/pages?pages=routes&range=today`);
  const card = page.getByRole('region', { name: 'Top pages' });
  await expect(card.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
  const folded = card.getByRole('button', { name: /^\/courses\/:slug/ });
  await expect(folded).toBeVisible();
  await expect(card.getByText(/No route rules yet/)).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^\/preview/ })).toHaveCount(0);
  // Pressing the folded row filters by the route, the same as any row.
  await folded.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('filters'))
    .toBe('route==/courses/:slug');

  // The site as it was.
  const restored = await page.request.patch(`/api/sites/${SITE}`, {
    data: { settings: { excludePaths: [], routeGroups: [] } },
  });
  expect(restored.ok()).toBe(true);
});

test('saves a segment from a channel filter, and compares the chart against it', async ({
  page,
}) => {
  await boot(page);
  // A channel row is a button now, and pressing it narrows the whole page.
  await page.getByRole('button', { name: /Organic search/ }).first().click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('filters'))
    .toBe('channel==organic');

  await page.getByRole('button', { name: 'Segments' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Organic in the suite');
  await page.getByRole('button', { name: 'Save the segment' }).click();

  // Listed, and comparable: the chip, the legend and the hidden table name it.
  await page.getByRole('button', { name: 'Segments' }).click();
  await expect(page.getByRole('button', { name: 'Apply Organic in the suite' })).toBeVisible();
  await page.getByRole('button', { name: 'Compare' }).first().click();
  await expect(page).toHaveURL(/vs=sg_/);
  await expect(page.getByText('Compared with Organic in the suite')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Organic in the suite' })).toBeAttached();

  // Deleted through the picker, and gone from the link.
  await page.getByRole('button', { name: 'Segments' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await page.getByRole('button', { name: 'Delete it' }).click();
  await expect(page.getByRole('button', { name: 'Apply Organic in the suite' })).toHaveCount(0);
  await expect(page).not.toHaveURL(/vs=/);
});

test('reads the settings page and the segments popover on a phone without a sideways scrollbar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/${SITE}/settings`);
  await expect(page.getByRole('region', { name: 'Route groups' })).toBeVisible();
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow(), 'the settings page scrolls sideways').toBeLessThanOrEqual(0);

  await boot(page, `/${SITE}?filters=channel%3D%3Dorganic`);
  await page.getByRole('button', { name: 'Segments' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
  expect(await overflow(), 'the segments popover pushes the page sideways').toBeLessThanOrEqual(0);
});

// Annotations and the Alerts page, over the real server.
//
// A mark posted through the API the way a deploy pipeline posts one, drawn on
// the chart and named in the hidden list; one added and deleted through the
// panel. And the first paid feature on an install with no key, which is the
// rule-10 case AN-EE01 left owed: the page is here, named, described, and
// there is nothing to fill in.
test('draws a deploy posted through the API as a mark, and adds and deletes one through the panel', async ({
  page,
}) => {
  await boot(page);
  const at = Date.now() - 2 * 60 * 60_000;
  const posted = await page.request.post(`/api/sites/${SITE}/annotations`, {
    data: { at, kind: 'deploy', text: 'v2.3.0 from the pipeline', url: 'https://example.test/r/2.3.0' },
  });
  expect(posted.status(), 'the annotation was refused').toBe(201);
  // The same statement again is one mark, not two.
  const again = await page.request.post(`/api/sites/${SITE}/annotations`, {
    data: { at, kind: 'deploy', text: 'v2.3.0 from the pipeline' },
  });
  expect(again.status()).toBe(409);

  await boot(page, `/${SITE}?range=today`);
  await expect(page.getByRole('button', { name: 'Annotations (1)' })).toBeVisible();
  await expect(page.locator('[class*="markGlyph"]')).toHaveCount(1);
  await expect(page.getByText('The marks on the chart above.')).toBeAttached();
  // Named twice on purpose: the guide's own tooltip and the hidden list.
  await expect(page.getByText(/Deploy: v2\.3\.0 from the pipeline/)).toHaveCount(2);

  // Through the panel: the owner adds a note and deletes it again.
  await page.getByRole('button', { name: 'Annotations (1)' }).click();
  await expect(page.getByRole('link', { name: 'Open the link' })).toBeVisible();
  await page.getByLabel('What happened').fill('Traffic looked odd');
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/annotations') && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Add the mark' }).click(),
  ]);
  expect(created.status(), await created.text()).toBe(201);
  await expect(page.getByRole('button', { name: 'Annotations (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Annotations (2)' }).click();
  await page.getByRole('button', { name: 'Delete' }).last().click();
  await page.getByRole('button', { name: 'Delete it' }).click();
  await expect(page.getByRole('button', { name: 'Annotations (1)' })).toBeVisible();

  // Left as it was found.
  const body = (await posted.json()) as { data: { annotation: { id: string } } };
  const removed = await page.request.delete(`/api/sites/${SITE}/annotations/${body.data.annotation.id}`);
  expect(removed.ok()).toBe(true);
});

test('shows the Alerts page on an install with no key: named, described, and nothing to fill in', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/${SITE}/alerts`);
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeAttached();
  await expect(page.getByText('Part of Chokh Pro', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Alerts is part of Chokh Pro. It is here, and a licence key turns it on.'),
  ).toBeVisible();
  // The fixture server runs the core with no packages/ee loaded, so the
  // refusal is a 404 and no reason is drawn; the four kinds are.
  await expect(page.getByText('Silence', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add an alert' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add the alert' })).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the Alerts page scrolls sideways at 390').toBeLessThanOrEqual(0);
});

// The public share (AN-RPT01): whoever holds the link reads the Overview in a
// browser that has never signed in, a password stands in the way when the
// owner set one, and nothing on the page leads to a person.
test('shares the Overview with whoever holds the link, behind a password when there is one', async ({
  page,
  browser,
}) => {
  const made = await page.request.put(`/api/sites/${SITE}/share`, { data: {} });
  expect(made.status(), 'the share was refused').toBe(200);
  const { token } = ((await made.json()) as { data: { share: { token: string } } }).data.share;
  const site = ((await (await page.request.get(`/api/sites/${SITE}`)).json()) as {
    data: { site: { name: string } };
  }).data.site;

  // A fresh context: no cookie, no session, nothing but the link.
  const context = await browser.newContext();
  const guest = await context.newPage();
  const answer = await guest.goto(`/share/${token}`);
  expect(answer?.headers()['x-robots-tag']).toBe('noindex');
  await expect(guest.getByRole('heading', { name: site.name, level: 1 })).toBeVisible();
  await expect(guest.getByRole('link', { name: /Powered by Chokh/ })).toBeVisible();
  await expect(guest.getByRole('group', { name: 'Date range' })).toBeVisible();
  await expect(guest.getByText('No data in this range.')).toHaveCount(0);
  await expect(guest.getByRole('region', { name: 'Top pages' })).toBeVisible();
  await expect(guest.getByRole('navigation', { name: 'Report' })).toHaveCount(0);
  await expect(guest.getByRole('link', { name: 'People' })).toHaveCount(0);
  await expect(guest.getByRole('link', { name: 'Realtime' })).toHaveCount(0);

  await page.request.put(`/api/sites/${SITE}/share`, { data: { password: 'open-sesame' } });
  await guest.reload();
  await expect(guest.getByRole('heading', { name: 'This page needs a password' })).toBeVisible();
  await guest.getByLabel('Password').fill('not-it-at-all');
  await guest.getByRole('button', { name: 'Open' }).click();
  await expect(guest.getByText('That is not the password.')).toBeVisible();
  await guest.getByLabel('Password').fill('open-sesame');
  await guest.getByRole('button', { name: 'Open' }).click();
  await expect(guest.getByRole('heading', { name: site.name, level: 1 })).toBeVisible();

  // The two embeds: the badge is an SVG anybody can fetch, the card is the
  // tiles alone in a page a frame may hold.
  await page.request.put(`/api/sites/${SITE}/share`, { data: { password: null } });
  const badge = await guest.request.get(`/api/share/${token}/widget.svg?metric=visitors&range=30d`);
  expect(badge.status()).toBe(200);
  expect(badge.headers()['content-type']).toContain('image/svg+xml');
  expect(await badge.text()).toContain('<title>Visitors, 30 days: ');
  const framed = await guest.goto(`/share/${token}/embed?range=30d`);
  expect(framed?.headers()['content-security-policy']).toBe('frame-ancestors *');
  await expect(guest.getByTestId('embed')).toBeVisible();
  await expect(guest.getByRole('group', { name: 'Date range' })).toHaveCount(0);
  const own = await guest.goto(`/share/${token}`);
  expect(own?.headers()['content-security-policy']).toBe("frame-ancestors 'none'");

  // Left as it was found: no share, and the old link opens nothing.
  await page.request.delete(`/api/sites/${SITE}/share`);
  await guest.reload();
  await expect(guest.getByText('This link does not open anything.')).toBeVisible();
  await context.close();
});
