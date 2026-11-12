// The real server, on the in-memory store, serving the real build.
//
// This is what the browser suite drives. A hand written mock answering /api
// from constants proves the dashboard against a server that does not exist:
// it cannot be wrong about the envelope, the session cookie, the redirect an
// expired session causes, the SSO landing or the stream, and every one of
// those is a seam the per-package tests cannot see. Those seams are the whole
// reason this suite exists.
//
// Fastify, the collector, the stats API, the stream and the static hosting are
// the ones from packages/server. Only storage is swapped, for a memory store,
// so nothing here needs MongoDB or Redis.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4112);

// The environment is read once when the server's config module is first
// imported, so every value has to be in place before that import happens.
process.env.DASHBOARD_DIR = resolve(HERE, '..', 'dist');
// Fixed, so a restart does not sign the suite out mid-run and two runs of the
// same suite sign the same cookie. A test secret in a test fixture on a test
// port, and the server refuses to boot in production without a real one.
process.env.SESSION_SECRET ??= 'chokh-e2e-session-secret-not-for-production';
// Pinned for the same reason, and mirrored in fixture-account.ts because a
// .mjs cannot import a .ts: the SSO case mints a token with this string and
// the server has to verify with it. An install that sets none refuses every
// exchange, so without this the SSO landing has no browser case at all.
process.env.SSO_SECRET ??= 'chokh-e2e-sso-secret-not-for-production';
process.env.LOG_LEVEL ??= 'error';
process.env.PORT = String(port);

const { buildApp } = await import('@chokh/server/app');
const { addDays, dayBounds, dayKey } = await import('@chokh/store/time');
const { createMemoryStore } = await import('@chokh/server/store/memory');

export const OWNER = { email: 'owner@chokh.test', password: 'a-long-enough-password' };
export const SITE_ID = 's_demo';

// The two errors the health case reads by name. The same strings
// fixture-account.ts exports, written twice because that file is a .ts and
// this one cannot import it.
const DATED_ERROR = 'RangeError: Maximum call stack size exceeded';
const RECENT_ERROR = "SyntaxError: Unexpected token '<'";
const TIMEZONE = 'Asia/Dhaka';

const DAY_MS = 86_400_000;

// Four course slugs and a pair of lessons, so a route rule has something to
// fold: /courses/:slug reads as one row over four pages on the Routes tab.
const PAGES = [
  '/',
  '/courses/competitive-programming',
  '/playground',
  '/pricing',
  '/learn/c',
  '/contests',
  '/blog/why-we-built-chokh',
  '/courses/c-from-scratch',
  '/courses/data-structures',
  '/courses/graphs',
  '/learn/c/pointers',
  '/learn/c/arrays',
];
const PLACES = [
  { country: 'BD', region: 'Dhaka', city: 'Dhaka', lat: 23.8103, lon: 90.4125 },
  { country: 'IN', region: 'West Bengal', city: 'Kolkata', lat: 22.5726, lon: 88.3639 },
  { country: 'US', region: 'California', city: 'San Jose', lat: 37.3382, lon: -121.8863 },
  { country: 'GB', region: 'England', city: 'London', lat: 51.5072, lon: -0.1276 },
];
// A browser with a system it actually ships on, because a developer reading a
// visitor list notices Safari on Windows.
const AGENTS = [
  { browser: 'Chrome', os: 'Android', device: 'mobile', screen: '360-767' },
  { browser: 'Chrome', os: 'Windows', device: 'desktop', screen: '1440+' },
  { browser: 'Safari', os: 'iOS', device: 'mobile', screen: '360-767' },
  { browser: 'Safari', os: 'macOS', device: 'desktop', screen: '1024-1439' },
  { browser: 'Firefox', os: 'Linux', device: 'desktop', screen: '1024-1439' },
];
const REFERRERS = [
  'https://www.google.com/',
  'https://news.ycombinator.com/',
  'https://chatgpt.com/',
  '',
];

function pageview(store, at, index, over = {}) {
  const place = PLACES[index % PLACES.length];
  const agent = AGENTS[index % AGENTS.length];
  const referrer = REFERRERS[index % REFERRERS.length];
  return {
    siteId: SITE_ID,
    ts: at,
    receivedAt: at,
    type: 'pageview',
    visitorId: `v_seed_${index}`,
    path: PAGES[index % PAGES.length],
    hostname: 'progsity.io',
    bot: false,
    lang: index % 3 === 0 ? 'bn' : 'en',
    screen: agent.screen,
    geo: place,
    ua: { browser: agent.browser, os: agent.os, device: agent.device },
    ...(referrer === '' ? {} : { referrer }),
    ...over,
  };
}

// A week of traffic, and nobody online at the end of it.
//
// Nothing is seeded inside the last minute on purpose: the stream case posts a
// batch of its own and watches the online count move from zero, which only
// proves anything if it started at zero.
async function seed(store, now) {
  const events = [];
  for (let day = 7; day >= 1; day -= 1) {
    const dayStart = now - day * DAY_MS;
    const count = 12 + ((day * 5) % 9);
    for (let index = 0; index < count; index += 1) {
      const at = dayStart + index * 97 * 60_000;
      const which = day * 100 + index;
      events.push(pageview(store, at, which));
      // A leave every third event, so "how far people read" has numbers and
      // the percentage it prints is one a real tracker would have sent.
      if (index % 3 === 0) {
        events.push({
          ...pageview(store, at + 90_000, which),
          type: 'leave',
          duration: 60_000 + (index % 5) * 45_000,
          scrollDepth: [25, 50, 75, 100][index % 4],
        });
      }
      if (index % 7 === 0) {
        events.push({ ...pageview(store, at + 30_000, which), type: 'event', name: 'signup' });
      }
      if (index % 11 === 0) {
        events.push({ ...pageview(store, at + 30_000, which), type: 'event', name: '404' });
      }
      // What v.js would have sent for this page load (AN-VIT01): phones slower
      // than desktops, and the pricing page slowest of all, so the slow pages
      // list has an order and the device split a difference.
      const agent = AGENTS[which % AGENTS.length];
      const slow = (agent.device === 'mobile' ? 1.8 : 1) * (PAGES[which % PAGES.length] === '/pricing' ? 1.6 : 1);
      for (const [name, base] of [['LCP', 1400], ['INP', 90], ['CLS', 0.04], ['FCP', 800], ['TTFB', 300]]) {
        const spread = 0.6 + ((index * 37 + day * 11) % 100) / 100;
        events.push({
          ...pageview(store, at + 2_000, which),
          type: 'vital',
          name,
          value: name === 'CLS' ? base * slow * spread : Math.round(base * slow * spread),
        });
      }
      // A JavaScript error now and then, one with a message long enough to
      // have to wrap on a phone.
      if (index % 5 === 0) {
        events.push({
          ...pageview(store, at + 3_000, which),
          type: 'error',
          name:
            index % 10 === 0
              ? "TypeError: Cannot read properties of undefined (reading 'checkoutSessionIdentifierFromTheVeryLongNamedPaymentProviderResponse')"
              : 'ReferenceError: gtag is not defined',
          frame: 'https://progsity.io/_next/static/chunks/app.js:1:2048',
        });
      }
    }
  }

  // One person the application named, so People has somebody to look up.
  const known = now - 2 * DAY_MS;
  events.push(
    pageview(store, known, 1, { visitorId: 'v_known', userId: 'u_known' }),
    { ...pageview(store, known + 60_000, 2, { visitorId: 'v_known', userId: 'u_known' }), type: 'event', name: 'checkout_start' },
    pageview(store, known + 120_000, 3, { visitorId: 'v_known', userId: 'u_known' }),
  );

  // Visits of several pages, so a funnel has people who got through it and
  // a journey has somewhere to go. Every other seeded visitor reads one page;
  // these walk, forty-five seconds a page, on the last three days.
  const WALKS = [
    ['/', '/courses/competitive-programming', '/pricing', '/learn/c'],
    ['/', '/pricing'],
    ['/learn/c', '/playground', '/learn/c', '/pricing', '/contests'],
    ['/blog/why-we-built-chokh', '/', '/courses/competitive-programming'],
    ['/', '/playground', '/playground', '/pricing'],
    ['/contests', '/pricing'],
  ];
  for (let day = 3; day >= 1; day -= 1) {
    WALKS.forEach((walk, which) => {
      const start = now - day * DAY_MS + 3 * 3_600_000 + which * 600_000;
      walk.forEach((path, step) => {
        events.push(
          pageview(store, start + step * 45_000, which + 1, {
            visitorId: `v_walk_${day}_${which}`,
            path,
          }),
        );
      });
    });
  }

  // People who come back (AN-PPL01), because everybody above is seen once and
  // a cohort grid of one column proves nothing. Ten regulars, one first seen in
  // each of the last ten weeks, each back every two to five days; every third
  // stops after a fortnight, so the grid thins out to the right, and every
  // other one came from a newsletter and signs up on their fourth visit, so
  // attribution has a first touch and a later one to tell apart. None is here
  // within the last two hours, so the stream case still starts from nobody.
  for (let regular = 0; regular < 10; regular += 1) {
    const visitorId = `v_regular_${regular}`;
    const first = now - (regular + 1) * 7 * DAY_MS - 5 * 3_600_000;
    const every = (2 + (regular % 4)) * DAY_MS;
    const until = regular % 3 === 2 ? first + 14 * DAY_MS : now - 2 * 3_600_000;
    let visit = 0;
    for (let at = first; at < until; at += every) {
      events.push(
        pageview(store, at, regular, {
          visitorId,
          path: PAGES[(regular + visit) % PAGES.length],
          ...(visit === 0 && regular % 2 === 0
            ? { utm: { source: 'newsletter', medium: 'email' } }
            : {}),
        }),
      );
      // The regulars' page loads measured too, so the slow pages list has
      // pages past the twenty samples a number needs.
      const agent = AGENTS[regular % AGENTS.length];
      const path = PAGES[(regular + visit) % PAGES.length];
      const slow = (agent.device === 'mobile' ? 1.8 : 1) * (path === '/pricing' ? 1.6 : 1);
      for (const [name, base] of [['LCP', 1400], ['INP', 90], ['CLS', 0.04], ['FCP', 800], ['TTFB', 300]]) {
        const spread = 0.6 + ((visit * 37 + regular * 11) % 100) / 100;
        events.push({
          ...pageview(store, at + 2_000, regular, { visitorId, path }),
          type: 'vital',
          name,
          value: name === 'CLS' ? base * slow * spread : Math.round(base * slow * spread),
        });
      }
      if (visit === 3 && regular % 2 === 0) {
        events.push({ ...pageview(store, at + 30_000, regular, { visitorId }), type: 'event', name: 'signup' });
      }
      visit += 1;
    }
  }

  // Two errors whose last sighting does not move with the hour this server
  // was started. Every row above is so many minutes from `now`, so which day of
  // the site's calendar it falls on depends on the clock: the health case once
  // looked among them for an error last seen on an earlier day, and found one
  // only when the run began between midnight and 07:50 in Dhaka.
  //
  // The first was last seen at noon two days ago by the site's own calendar,
  // an earlier day at every hour, so the page has to print its day. The second
  // was last seen two to three minutes ago, on the minute; the case pins the
  // page's clock on that same minute, so the page has to print no day at all
  // whenever the run began, a second before midnight included.
  const dated = dayBounds(addDays(dayKey(now, TIMEZONE), -2), TIMEZONE).start + 12 * 60 * 60_000;
  const recent = Math.floor((now - 2 * 60_000) / 60_000) * 60_000;
  const frame = 'https://progsity.io/_next/static/chunks/app.js:1:2048';
  events.push(
    { ...pageview(store, dated, 901), type: 'error', name: DATED_ERROR, frame },
    { ...pageview(store, recent, 902), type: 'error', name: RECENT_ERROR, frame },
  );

  await store.ingest(events);

  // Every finished day rolled up, because that is where a past day's numbers
  // are read from: the contract answers today and the recent window from raw
  // events and everything before it from rollups_daily, so a seed that only
  // writes events leaves a dashboard that says a week of nothing. The job that
  // does this on a real install runs nightly.
  for (let day = 8; day >= 1; day -= 1) {
    await store.rollupDay(SITE_ID, dayKey(now - day * DAY_MS, TIMEZONE));
  }
}

const store = createMemoryStore();
const app = await buildApp({ store });
await app.listen({ port, host: '127.0.0.1' });

// The owner and the site are created over HTTP rather than written into the
// store, so the suite starts from an install that went through the same
// register and create-site routes anybody else would.
const base = `http://127.0.0.1:${port}`;
// Anything that goes wrong here stops the process rather than leaving a server
// up with no account and no site in it: the suite would then report ten
// product failures for one setup failure, which is a morning nobody gets back.
async function must(what, response) {
  if (!response.ok) {
    console.error(`${what} failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  return response;
}

const registered = await must(
  'register the owner',
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...OWNER, name: 'Abu Jafar' }),
  }),
);
const cookie = registered.headers.get('set-cookie')?.split(';')[0] ?? '';
await must(
  'create the site',
  await fetch(`${base}/api/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      id: SITE_ID,
      name: 'Progsity',
      // The loopback address is here because the suite's own pageviews are
      // posted from a page this server serves, and the collector refuses a
      // batch whose Origin is not a domain of the site. A real install
      // measuring itself on its own host lists the same thing.
      domains: ['progsity.io', '127.0.0.1'],
      settings: { timezone: TIMEZONE, visitorIdMode: 'persistent', errorCapture: true },
    }),
  }),
);

await seed(store, Date.now());

// One funnel, made over HTTP like the site, so the Funnels page the suite and
// the accessibility audit open has a funnel on it rather than only the
// builder. Pages only, so no goal case in the suite ever meets it.
await must(
  'create a funnel',
  await fetch(`${base}/api/sites/${SITE_ID}/funnels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: 'Home to pricing',
      window: '1d',
      steps: [{ page: '/' }, { page: '/pricing' }],
    }),
  }),
);

console.warn(`chokh e2e server on ${base}`);
