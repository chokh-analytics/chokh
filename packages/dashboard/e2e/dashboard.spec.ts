import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The real signer and the real claim builder, so the token this suite presents
// is the one an application would mint rather than a hand rolled lookalike that
// can agree with a verifier they both got wrong.
import { signHs256 } from '@chokh/server/jwt';
import { ssoClaimsFor } from '@chokh/server/sso';

import { DATED_ERROR, OWNER, RECENT_ERROR, SSO_SECRET } from './fixture-account.js';
import { DESTINATIONS, goTo } from './nav.js';

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
    ['Retention', 'Retention'],
    ['Health', 'Health'],
    ['Alerts', 'Alerts'],
  ] as const) {
    await goTo(page, label);
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
test('keeps the destinations in one row at 390 and at 1024, with the current one in view', async ({
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
      ['retention', 'Retention'],
      ['health', 'Health'],
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
      // The current one is a link in the row, or, when it went under More, the
      // More trigger standing in for it with the current mark (AN-DSH03).
      const link = nav.getByRole('link', { name: label, exact: true });
      const current =
        (await link.count()) > 0
          ? await link.boundingBox()
          : await nav
              .getByRole('button', { name: `More destinations, including ${label}, the page you are on` })
              .boundingBox();
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
          .getByRole('group', { name: 'Goals', exact: true })
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

  // Seven days and not today: the mark is two hours old, and for the first two
  // hours of the site's day that is yesterday.
  await boot(page, `/${SITE}?range=7d`);
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
  // Two paid features on the page now, alerts and digests, each with its badge.
  await expect(page.getByText('Part of Chokh Pro', { exact: true })).toHaveCount(2);
  await expect(
    page.getByText('Alerts is part of Chokh Pro. It is here, and a licence key turns it on.'),
  ).toBeVisible();
  // The fixture server runs the core with no packages/ee loaded, so the
  // refusal is a 404 and no reason is drawn; the four kinds are.
  await expect(page.getByText('Silence', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add an alert' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add the alert' })).toHaveCount(0);
  // The digests (AN-RPT01) on the same page, described the same way.
  await expect(page.getByRole('region', { name: 'Digests' })).toBeVisible();
  await expect(
    page.getByText('Digests is part of Chokh Pro. It is here, and a licence key turns it on.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add the digest' })).toHaveCount(0);
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

// AN-DSH03: no destination is ever hidden without a control on screen that
// reveals it. Wider than a phone, every destination is a link in the row or an
// item under More, in order, every row link is inside the row's box, More opens
// from the keyboard, closes on Escape with the focus back on it, and goes to a
// destination; the page it went to is then marked on the trigger. On a phone
// the scrolling row fades on the side that has more.
test('shows every destination in the row or under More at 1024 and 1280, and fades the cut on a phone', async ({
  page,
}) => {
  let movedThroughMore = false;
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await boot(page, `/${SITE}/realtime`);
    const nav = page.getByRole('navigation', { name: 'Report' });
    const row = await nav.boundingBox();
    const links = nav.getByRole('link');
    const inRow = await links.allTextContents();
    for (let index = 0; index < inRow.length; index += 1) {
      const box = await links.nth(index).boundingBox();
      expect(box !== null && row !== null && box.x + box.width <= row.x + row.width + 1, `${inRow[index]} is cut off at ${width}`).toBe(true);
    }
    const more = nav.getByRole('button', { name: /^More destinations/ });
    let under: string[] = [];
    if ((await more.count()) > 0) {
      await more.focus();
      await page.keyboard.press('Enter');
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      const panel = page.getByRole('group', { name: 'More destinations' });
      under = await panel.getByRole('link').allTextContents();
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(more).toBeFocused();
    }
    expect([...inRow, ...under], `at ${width}`).toEqual(DESTINATIONS);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the bar widens the page at ${width}`).toBeLessThanOrEqual(0);

    const last = under[under.length - 1];
    if (last !== undefined) {
      await more.click();
      await page.getByRole('group', { name: 'More destinations' }).getByRole('link', { name: last, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
      const marked = nav.getByRole('button', { name: `More destinations, including ${last}, the page you are on` });
      await expect(marked).toBeVisible();
      await marked.click();
      await expect(
        page.getByRole('group', { name: 'More destinations' }).getByRole('link', { name: last, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await page.keyboard.press('Escape');
      movedThroughMore = true;
    }
  }
  // Thirteen destinations beside the mark, the site and the account do not fit
  // in 1024, so this case went through More at least once.
  expect(movedThroughMore).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/${SITE}`);
  const nav = page.getByRole('navigation', { name: 'Report' });
  await expect(nav).toHaveClass(/fadeRight/);
  await expect(nav).not.toHaveClass(/fadeLeft/);
  await boot(page, `/${SITE}/alerts`);
  await expect(nav).toHaveClass(/fadeLeft/);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

// The people directory (AN-PPL02) against the real server: the list is the
// visitor rows, the search finds the one person the fixture's application
// named, a row opens their profile, and the filtered list is still there on
// the way back because it lives in the address bar.
test('lists everybody on People, finds a named person and opens them', async ({ page }) => {
  await boot(page, `/${SITE}/people`);
  const list = page.getByRole('region', { name: 'Everybody' });
  const table = list.getByRole('group', { name: 'Everybody this site has seen, the most recent first' });
  await expect(table.getByRole('row').nth(2)).toBeVisible();
  const first = await table.getByRole('row').count();
  // The fixture runs back a week, so the column carries days and not a clock
  // time that wraps (AN-PPL02's review): some row is from another day.
  // A short month is three letters or four (Sept), and a row from the other
  // side of a new year carries its year as well.
  const seen = await table.locator('tbody tr td:nth-child(2)').allTextContents();
  expect(seen.some((text) => /^\d{1,2} [A-Z][a-z]{2,3}( \d{4})?, \d\d:\d\d$/.test(text))).toBe(true);

  const more = list.getByRole('button', { name: 'Show more' });
  if (await more.isVisible()) {
    await more.click();
    await expect.poll(() => table.getByRole('row').count()).toBeGreaterThan(first);
  }

  await list.getByLabel('Search').fill('u_known');
  await expect(page).toHaveURL(/[?&]q=u_known/);
  await expect(list.getByText('All 1 shown')).toBeVisible();
  await list.getByRole('link', { name: /u_known/ }).click();
  await expect(page).toHaveURL(new RegExp(`/${SITE}/people/v/v_known$`));
  await expect(page.getByRole('region', { name: 'Profile' }).getByText('u_known')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/[?&]q=u_known/);
  await expect(list.getByLabel('Search')).toHaveValue('u_known');
  await expect(list.getByText('All 1 shown')).toBeVisible();
});

test('keeps to the identified with the switch, from the keyboard', async ({ page }) => {
  await boot(page, `/${SITE}/people`);
  const list = page.getByRole('region', { name: 'Everybody' });
  const toggle = list.getByRole('switch', { name: 'Only people you identified' });
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await expect(page).toHaveURL(/[?&]named=1/);
  await expect(list.getByRole('link', { name: /u_known/ })).toBeVisible();
  // Everybody left on the list has a name: none of them reads as a visitor.
  await expect(list.getByRole('link', { name: /^Visitor/ })).toHaveCount(0);
});

// The directory is six columns, wider than a phone: it scrolls inside its card
// and the page never moves sideways.
test('keeps the people directory inside a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/${SITE}/people`);
  const table = page.getByRole('group', {
    name: 'Everybody this site has seen, the most recent first',
  });
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'people scrolls sideways').toBeLessThanOrEqual(0);
  const inner = await table.evaluate((box) => box.scrollWidth - box.clientWidth);
  expect(inner, 'the directory lost its columns rather than scrolling them').toBeGreaterThan(0);
});

// Retention (AN-PPL01) against the real server: the regulars the seed brings
// back fill a cohort grid whose running week is marked, the grid scrolls inside
// its card on a phone while the page does not, the views and the windows are
// reachable from the keyboard and kept in the address bar, the most active
// people carry the day they were last seen, and attribution splits a goal made
// over the API both ways.
test('reads the cohort grid on a phone inside its card, with the running week marked', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/${SITE}/retention`);
  await expect(page.getByRole('heading', { name: 'Retention', level: 1 })).toBeAttached();
  const grid = page.getByRole('group', { name: /Cohorts by when people were first seen/ });
  await expect(grid.getByRole('row').nth(12)).toBeVisible();
  // Somebody came back in a later week: a rate above zero past the first column.
  const later = await grid.locator('tbody tr td:nth-child(4)').allTextContents();
  expect(later.some((text) => /^[1-9]\d*(\.\d)?%/.test(text)), later.join(' | ')).toBe(true);
  await expect(grid.getByText(/still running/).first()).toBeAttached();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'retention scrolls sideways').toBeLessThanOrEqual(0);
  const inner = await grid.evaluate((box) => box.scrollWidth - box.clientWidth);
  expect(inner, 'the grid lost its weeks rather than scrolling them').toBeGreaterThan(0);
  // The first column holds still while the weeks scroll past it.
  await grid.evaluate((box) => {
    box.scrollLeft = box.scrollWidth;
  });
  const sticky = await grid.locator('tbody th').first().boundingBox();
  const box = await grid.boundingBox();
  expect(sticky !== null && box !== null && sticky.x <= box.x + 2).toBe(true);
});

test('walks the retention views from the keyboard and keeps each in the address bar', async ({ page }) => {
  await boot(page, `/${SITE}/retention`);
  const monthly = page.getByRole('radio', { name: 'Monthly' });
  await monthly.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/[?&]interval=month/);
  await expect(page.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('tab', { name: 'Activity' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/[?&]view=activity/);
  const people = page.getByRole('group', { name: 'The most active people of the window' });
  await expect(people.getByRole('row').nth(1)).toBeVisible();
  // A list over thirty days says which day, not a bare clock time.
  const seen = await people.locator('tbody tr td:nth-child(4)').allTextContents();
  expect(seen.every((text) => /^(now|\d+m|\d\d:\d\d|\d{1,2} [A-Z][a-z]{2,3}, \d\d:\d\d)$/.test(text)), seen.join(' | ')).toBe(true);
  expect(seen.some((text) => /^\d{1,2} [A-Z][a-z]{2,3}, \d\d:\d\d$/.test(text))).toBe(true);
  await expect(page.getByRole('table', { name: /number of days they were active/ })).toBeAttached();

  // Over ninety days a power user is active on thirty of them, which nobody in
  // the seed is: the list says so in those words rather than going blank.
  await page.getByRole('radio', { name: 'Last 90 days' }).click();
  await expect(page).toHaveURL(/[?&]window=90/);
  await expect(page.getByText('Nobody was active on 30 or more days of this window.')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'activity scrolls sideways').toBeLessThanOrEqual(0);
});

test('splits a goal by first touch and last touch', async ({ page }) => {
  const created = await page.request.post(`/api/sites/${SITE}/goals`, {
    data: { name: 'Signed up in the attribution case', kind: 'event', match: 'signup' },
  });
  const body = (await created.json()) as {
    data?: { goal: { id: string } };
    error?: { details?: { goalId?: string } };
  };
  const goalId = body.data?.goal.id ?? body.error?.details?.goalId;
  expect(goalId, `the goal was refused: ${JSON.stringify(body)}`).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/${SITE}/retention?view=attribution&window=90&goal=${goalId as string}`);
  const table = page.getByRole('group', { name: /by first touch and by last touch/ });
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  // The newsletter brought the regulars who signed up; their later visits did
  // not, so Email is a first touch and something else is a last one.
  const email = table.getByRole('row', { name: /^Email/ });
  await expect(email).toBeVisible();
  await expect(page.getByText(/people converted, \d+ times/)).toBeVisible();
  await page.getByLabel('Split by').selectOption('utm_source');
  await expect(page).toHaveURL(/[?&]split=utm_source/);
  await expect(table.getByRole('row', { name: /^newsletter/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'attribution scrolls sideways').toBeLessThanOrEqual(0);

  const removed = await page.request.delete(`/api/sites/${SITE}/goals/${goalId as string}`);
  expect(removed.ok()).toBe(true);
});

// Health (AN-VIT01) against the real server: the vitals and errors the seed
// posts as v.js and e.js would fill the page; every band is a word as well as a
// colour; the slow pages table scrolls inside its card on a phone while the
// page does not; an error opens to its sample with the day it was seen; and the
// views are reachable from the keyboard and kept in the address bar.
test('reads page speed on a phone, the bands in words and the slow pages inside their card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `/${SITE}/health`);
  await expect(page.getByRole('heading', { name: 'Health', level: 1 })).toBeAttached();
  const lcp = page.getByRole('region', { name: 'Largest Contentful Paint' });
  await expect(lcp.getByText(/^\d+\.\d\d s$/)).toBeVisible();
  await expect(lcp.getByText(/^(Good|Needs improvement|Poor)$/).first()).toBeVisible();
  const inp = page.getByRole('region', { name: 'Interaction to Next Paint' });
  await expect(inp.getByText(/^\d[\d,]* ms$/)).toBeVisible();
  const cls = page.getByRole('region', { name: 'Cumulative Layout Shift' });
  await expect(cls.getByText(/^\d\.\d\d$/)).toBeVisible();
  // Phones were seeded slower than desktops, and both are measured.
  await expect(lcp.getByRole('list', { name: 'By device' }).getByText('Mobile')).toBeVisible();
  const table = page.getByRole('group', { name: /Pages by their 75th percentile/ });
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'health scrolls sideways').toBeLessThanOrEqual(0);
  const inner = await table.evaluate((box) => box.scrollWidth - box.clientWidth);
  expect(inner, 'the slow pages lost their columns rather than scrolling them').toBeGreaterThan(0);
});

test('opens an error to its sample, on a phone, with the day it was last seen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // What the page prints for a last sighting depends on the day it is read
  // on, so the case fixes the day rather than hoping for one: the page's clock
  // is pinned on the minute the fixture seeded its newest error at, whenever
  // that was. On it and not after it, because the page rounds its own clock up
  // to the minute. Timers still run; only "now" stands still.
  const week = 7 * 24 * 60 * 60_000;
  const answer = await page.request.get(
    `/api/sites/${SITE}/stats/errors?from=${Date.now() - week}&to=${Date.now()}`,
  );
  expect(answer.ok(), await answer.text()).toBe(true);
  const read = (await answer.json()) as { data: { groups: { message: string; lastSeen: number }[] } };
  const recent = read.data.groups.find((group) => group.message === RECENT_ERROR);
  expect(recent, 'the fixture did not seed the recent error').toBeDefined();
  await page.clock.setFixedTime(new Date(recent?.lastSeen ?? 0));

  await boot(page, `/${SITE}/health?view=errors`);
  const list = page.getByRole('region', { name: 'JavaScript errors' });
  const long = list.getByText(/checkoutSessionIdentifierFromTheVeryLongNamedPaymentProviderResponse/);
  await expect(long).toBeVisible();
  const lastSeen = (message: string) =>
    list.locator('details', { hasText: message }).getByText(/^Last seen /);
  // Last seen at noon two days ago by the site's calendar: its day, and its
  // year too in the two days after a new year.
  await expect(lastSeen(DATED_ERROR)).toHaveText(/^Last seen \d{1,2} [A-Z][a-z]{2,3}( \d{4})?, 12:00$/);
  // And the other side, so this cannot pass by printing a day on everything:
  // an error seen a moment ago carries none.
  await expect(lastSeen(RECENT_ERROR)).toHaveText('Last seen now');
  await long.click();
  await expect(list.getByText('https://progsity.io/_next/static/chunks/app.js:1:2048').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'a long error message widens the page').toBeLessThanOrEqual(0);
});

test('walks the health views and windows from the keyboard and keeps each in the address bar', async ({ page }) => {
  await boot(page, `/${SITE}/health`);
  const errorsTab = page.getByRole('tab', { name: 'Errors' });
  await errorsTab.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/view=errors/);
  await expect(errorsTab).toHaveAttribute('aria-selected', 'true');
  const ninety = page.getByRole('radio', { name: 'Last 90 days' });
  await ninety.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/window=90/);
  await page.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page).toHaveURL(/view=coverage/);
  // The seed's server sends no events, so the estimate says why it has none.
  await expect(page.getByText(/this site sends no server events/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Coverage' })).toHaveAttribute('aria-selected', 'true');
});

// AN-TEAM01: who can reach a site, and the record of who looked at whom.
//
// What only a browser against the real server can say: that the pages are
// reached from the navigation with a keyboard, that an invitation's link is
// shown once and lets exactly its person in, that the token is out of the
// address bar before anything asks a server anything and is in no address, no
// storage and no request to anywhere else, that a removal ends the session a
// browser is holding, and that the audit log is asked for when somebody asks
// and at no other time.
test.describe.serial('teams, invitations and the audit log', () => {
  const INVITED = 'invited@chokh.test';
  const THEIR_PASSWORD = 'a-password-of-their-own';
  // A browser with nobody signed in. Said out loud, because a context made in
  // a test starts with the session the whole suite shares unless it is told
  // otherwise, and an invitation opened by the owner is a different page.
  const NOBODY = { storageState: { cookies: [], origins: [] } };

  async function openFromSiteMenu(page: Page, link: string): Promise<void> {
    const menu = page.getByRole('button', { name: /^Progsity/ });
    await menu.focus();
    await page.keyboard.press('Enter');
    const item = page.getByRole('link', { name: link });
    await item.focus();
    await page.keyboard.press('Enter');
  }

  function storedText(page: Page): Promise<string> {
    return page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookie: document.cookie,
      }),
    );
  }

  test('invites somebody from the Team page by keyboard, shows the link once, and lets them in by it', async ({
    page,
    browser,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await boot(page);
    await openFromSiteMenu(page, 'Team and invitations');
    await expect(page).toHaveURL(new RegExp(`/${SITE}/team$`));
    await expect(page.getByRole('heading', { name: 'Who can see Progsity', level: 1 })).toBeVisible();

    // More than one team is part of Chokh Pro and this install has no key:
    // the card is there, named and labelled, with nothing in it to fill in
    // (AGENTS.md rule 10), and the team that exists is listed all the same.
    const teams = page.getByRole('region', { name: 'More than one team' });
    await expect(teams.getByText('Part of Chokh Pro', { exact: true })).toBeVisible();
    await expect(teams.getByRole('list', { name: 'The teams you are in' })).toContainText('Default');
    await expect(teams.getByRole('textbox')).toHaveCount(0);
    await expect(teams.getByRole('button')).toHaveCount(0);

    // The form, from the keyboard: an address, and Enter.
    const form = page.getByRole('region', { name: 'Invite somebody' });
    await form.getByLabel('Their email').fill(INVITED);
    await page.keyboard.press('Enter');

    const once = page.getByRole('group', { name: `The link for ${INVITED}` });
    await expect(once).toBeFocused();
    await expect(once.getByText(/shown once and will not be shown again/)).toBeVisible();
    const link = await once.getByLabel('The invitation link').inputValue();
    expect(link).toMatch(new RegExp(`^${ORIGIN}/invite#chi_[A-Za-z0-9_-]{40,}$`));
    const token = link.split('#')[1] ?? '';
    await once.getByRole('button', { name: 'Copy the link' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    // Shown once: a reload has the invitation in the list and the link nowhere.
    await page.reload();
    const waiting = page.getByRole('region', { name: 'Invitations waiting' });
    await expect(waiting.getByText(INVITED)).toBeVisible();
    await expect(waiting.getByText(/Waiting\. The link works until/)).toBeVisible();
    expect(await page.content()).not.toContain(token);
    expect(await storedText(page)).not.toContain(token);

    // The person it was sent to, in a browser of their own with nothing in it.
    const context = await browser.newContext(NOBODY);
    const guest = await context.newPage();
    const asked: { url: string; body: string | null }[] = [];
    guest.on('request', (request) => asked.push({ url: request.url(), body: request.postData() }));
    await guest.goto(link);
    await expect(guest.getByText(`invited ${INVITED} to the team Default, as Viewer.`)).toBeVisible();

    // Out of the address bar, parked nowhere, written to no storage.
    expect(guest.url()).toBe(`${ORIGIN}/invite`);
    expect(await guest.evaluate(() => window.location.hash)).toBe('');
    expect(await guest.evaluate(() => '__chokhInvite' in window)).toBe(false);
    expect(await storedText(guest)).not.toContain(token);
    // Every request went to this server, none carried the token in its
    // address, and the one that carried it at all carried it in a body.
    expect(asked.length).toBeGreaterThan(3);
    for (const request of asked) {
      expect(new URL(request.url).origin).toBe(ORIGIN);
      expect(request.url).not.toContain(token);
    }
    expect(
      asked.filter((request) => (request.body ?? '').includes(token)).map((request) => request.url),
    ).toEqual([`${ORIGIN}/api/invitations/lookup`]);

    // They choose a password of their own, and are in.
    await guest.getByLabel('Choose a password').fill(THEIR_PASSWORD);
    await guest.keyboard.press('Enter');
    await expect(guest.getByRole('navigation', { name: 'Report' })).toBeVisible();
    await expect(guest).toHaveURL(new RegExp(`/${SITE}$`));
    expect(JSON.stringify(await (await guest.request.get('/api/me')).json())).toContain(INVITED);

    // A viewer is told who the Team page is for, and is not sent to be refused.
    const refused: string[] = [];
    guest.on('response', (response) => {
      if (response.status() === 403) refused.push(response.url());
    });
    await guest.goto(`/${SITE}/team`);
    await expect(guest.getByText(/Only an owner of this site, or of the team it belongs to/)).toBeVisible();
    await expect(guest.getByRole('region', { name: 'Invite somebody' })).toHaveCount(0);
    expect(refused).toEqual([]);

    // The link is spent, and the page it opened has forgotten it anyway.
    await guest.goto('/invite');
    await expect(guest.getByText(/This page opens from an invitation link/)).toBeVisible();

    // The owner sees them in the team, and nothing left waiting.
    await page.reload();
    const team = page.getByRole('region', { name: 'The team, Default' });
    await expect(team.getByText(INVITED)).toBeVisible();
    await expect(page.getByText('Nobody is waiting on an invitation.')).toBeVisible();

    // Removed, and the session their browser is holding ends with it.
    await team.getByRole('button', { name: `Remove ${INVITED}` }).click();
    await team.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(team.getByText('Removed, and signed out.')).toBeVisible();
    await expect(team.getByText(INVITED)).toHaveCount(0);
    await guest.goto(`/${SITE}`);
    await expect(guest).toHaveURL(/\/login/);
    await context.close();
  });

  test('lets an address that already has an account sign in on the invitation page, to one site only', async ({
    page,
    browser,
  }) => {
    // The account the case above made, now in no team.
    const made = await page.request.post(`/api/sites/${SITE}/invitations`, {
      data: { email: INVITED, role: 'editor', identity: false },
    });
    expect(made.status(), 'the invitation was refused').toBe(201);
    const { link } = ((await made.json()) as { data: { once: { link: string } } }).data.once;

    // Opened by somebody signed in as another account, it says whose it is
    // and offers neither form: it is accepted by its own address or nobody.
    await page.goto(link);
    await expect(
      page.getByText(`This invitation is for ${INVITED}, and you are signed in as ${OWNER.email}.`),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept the invitation' })).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveCount(0);
    expect(page.url()).toBe(`${ORIGIN}/invite`);

    const context = await browser.newContext(NOBODY);
    const guest = await context.newPage();
    await guest.goto(link);
    await expect(guest.getByText(`invited ${INVITED} to the site Progsity, as Editor.`)).toBeVisible();
    await expect(guest.getByText(/An account with this address already exists/)).toBeVisible();
    expect(guest.url()).toBe(`${ORIGIN}/invite`);
    // No password to choose: the account has one, and it is asked for here.
    await expect(guest.getByLabel('Choose a password')).toHaveCount(0);
    await guest.getByLabel('Password').fill(THEIR_PASSWORD);
    await guest.keyboard.press('Enter');
    await expect(guest.getByRole('navigation', { name: 'Report' })).toBeVisible();
    await expect(guest).toHaveURL(new RegExp(`/${SITE}$`));
    await context.close();

    // On the owner's page they hold a role on this site alone, and are not in
    // the team. Taken off again, so the next case finds the site as it was.
    await boot(page, `/${SITE}/team`);
    const site = page.getByRole('region', { name: 'On this site only' });
    await expect(site.getByText(INVITED)).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'The team, Default' }).getByText(INVITED),
    ).toHaveCount(0);
    await site.getByRole('button', { name: `Remove ${INVITED}` }).click();
    await site.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Nobody holds a role on this site alone.')).toBeVisible();
  });

  test('reads the audit log, and asks for it only when somebody asks', async ({ page }) => {
    const opened: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/audit')) opened.push(`${url.pathname}${url.search}`);
    });

    await boot(page);
    await openFromSiteMenu(page, 'Audit log');
    await expect(page).toHaveURL(new RegExp(`/${SITE}/audit$`));
    const log = page.getByRole('table', { name: 'The audit log, newest first.' });
    // What the two cases above left behind on this site, in words.
    await expect(log.getByText('Sent an invitation').first()).toBeVisible();
    await expect(log.getByText('An invitation was used').first()).toBeVisible();
    await expect(page.getByText(/Opening this list is itself written to it/)).toBeVisible();
    expect(opened).toEqual([`/api/sites/${SITE}/audit?limit=50`]);

    // The tab is left and returned to, the window loses the focus and gets it
    // back, the network drops and returns: none of it is somebody asking.
    await page.evaluate(() => {
      const set = (state: string): void => {
        Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      set('hidden');
      window.dispatchEvent(new Event('blur'));
      set('visible');
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await page.waitForTimeout(1_500);
    expect(opened).toHaveLength(1);

    // Opened again, by somebody pressing the button: one more request, and
    // the first opening is now a row.
    await page.getByRole('button', { name: 'Open the log again' }).click();
    await expect(log.getByText('Opened the audit log').first()).toBeVisible();
    expect(opened).toHaveLength(2);

    // Narrowed from the form, which asks when Show is pressed and not before.
    await page.getByLabel('Show').selectOption('access');
    await page.waitForTimeout(400);
    expect(opened).toHaveLength(2);
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(page).toHaveURL(/[?&]kind=access/);
    await expect(log.getByText('Sent an invitation').first()).toBeVisible();
    await expect(log.getByText('Opened the audit log')).toHaveCount(0);
    expect(opened[2]).toBe(`/api/sites/${SITE}/audit?kind=access&limit=50`);

    // The team's own log, by keyboard: what happened to the team is there.
    const team = page.getByRole('tab', { name: 'The team' });
    await team.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/[?&]log=team/);
    await expect(team).toHaveAttribute('aria-selected', 'true');
    await expect(log.getByText('Removed somebody').first()).toBeVisible();
    expect(opened[3]).toContain('/api/teams/default/audit');
    expect(opened).toHaveLength(4);
  });

  test('keeps the Team page, the audit log and the invitation page inside a laptop, a small laptop and a phone', async ({
    page,
    browser,
  }) => {
    const overflow = (target: Page): Promise<number> =>
      target.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

    for (const width of [1280, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await boot(page, `/${SITE}/team`);
      await expect(
        page.getByRole('region', { name: 'The team, Default' }).getByRole('list'),
      ).toBeVisible();
      expect(await overflow(page), `the Team page at ${width}`).toBe(0);
      // The way to the other two pages is on screen at every width.
      await expect(
        page.getByRole('navigation', { name: 'About this site' }).getByRole('link'),
      ).toHaveCount(3);
    }

    // One opening of the log for all three widths: it is resized, not reread.
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, `/${SITE}/audit`);
    const box = page.getByRole('group', { name: 'The audit log, newest first.' });
    await expect(box).toBeVisible();
    for (const width of [1280, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      // Polled, because the bar refits its destinations a frame after the
      // window changes size; what is held is where it settles.
      await expect.poll(() => overflow(page), `the audit log at ${width}`).toBe(0);
    }
    // Five columns do not fit a phone: the table scrolls inside its card, and
    // the box can take the focus so a keyboard can scroll it.
    expect(
      await box.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeGreaterThan(0);
    await box.focus();
    await expect(box).toBeFocused();

    const made = await page.request.post(`/api/sites/${SITE}/invitations`, {
      data: {
        email: 'somebody-with-a-long-address@a-long-company-name.test',
        role: 'viewer',
        identity: true,
      },
    });
    const sent = (
      (await made.json()) as { data: { invitation: { id: string }; once: { link: string } } }
    ).data;
    const context = await browser.newContext(NOBODY);
    const guest = await context.newPage();
    await guest.setViewportSize({ width: 390, height: 844 });
    // Opened in a tab that is already on the page, which is a change of
    // fragment and not a load: nothing that runs at load runs again, and the
    // token still comes out of the address bar and the page still reads it.
    await guest.goto('/invite');
    await expect(guest.getByText(/This page opens from an invitation link/)).toBeVisible();
    await guest.goto(sent.once.link);
    await expect(guest.getByRole('button', { name: 'Make the account and accept' })).toBeVisible();
    expect(guest.url()).toBe(`${ORIGIN}/invite`);
    for (const width of [390, 1024, 1280]) {
      await guest.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await expect.poll(() => overflow(guest), `the invitation page at ${width}`).toBe(0);
    }
    await context.close();
    // Taken back, so nothing is left waiting.
    const revoked = await page.request.delete(
      `/api/sites/${SITE}/invitations/${sent.invitation.id}`,
    );
    expect(revoked.status()).toBe(200);
  });
});
