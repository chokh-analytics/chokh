// The twenty-two pictures: eleven views, two themes.
//
// A developer decides in about ten seconds of screenshots whether a dashboard
// is worth installing, so these are a deliverable rather than a debugging aid,
// and they are taken from the built files against the fixture install so the
// same command produces the same pictures every time. A README picture that
// changes on every run cannot be reviewed.
//
// The clock is frozen, because "2 minutes ago" in a screenshot taken last
// Tuesday is a picture that ages badly, and because a moving number makes two
// runs differ for no reason.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import { NOW } from '../e2e/fixture-data.mjs';
import { startFixture } from '../e2e/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'screenshots');
// The ones the README carries, and every one of them is embedded in it: a
// picture committed and referenced from nowhere is a file nobody can find and
// nobody can delete. All twenty-two are taken every run and the rest are not
// committed, because a README picture has to be in the repository to be a
// README picture and the other fourteen are a regenerable command away.
const README_OUT = resolve(HERE, '..', '..', '..', 'docs', 'images');
const README_SHOTS = new Map([
  ['01-overview-light', 'dashboard-overview-light.png'],
  ['02-realtime-dark', 'dashboard-realtime-dark.png'],
  ['05-geo-light', 'dashboard-geo-light.png'],
  ['07-people-dark', 'dashboard-people-dark.png'],
  ['08-events-dark', 'dashboard-events-dark.png'],
  ['09-goals-light', 'dashboard-goals-light.png'],
  ['10-funnels-light', 'dashboard-funnels-light.png'],
  ['11-journeys-dark', 'dashboard-journeys-dark.png'],
]);
// A port of its own, so the frozen fixture and the real server the browser
// suite drives never take each other's place: a screenshot of live data is a
// picture nobody can review, and an audit of the fixture is an audit of a mock.
const port = Number(process.env.PORT ?? 4113);
const fixture = await startFixture(port);
const base = fixture.base;

const SITE = 's_demo';
const PAGES = [
  { name: '01-overview', path: `/${SITE}` },
  { name: '02-realtime', path: `/${SITE}/realtime` },
  { name: '03-pages', path: `/${SITE}/pages` },
  { name: '04-sources', path: `/${SITE}/sources` },
  { name: '05-geo', path: `/${SITE}/geo` },
  { name: '06-devices', path: `/${SITE}/devices` },
  { name: '07-people', path: `/${SITE}/people/v/v_abcdef0001` },
  // An event chosen, so the picture has its property breakdown under it.
  { name: '08-events', path: `/${SITE}/events?filters=event%3D%3Dsignup` },
  // A goal chosen, so the picture has the chip and the chosen row.
  { name: '09-goals', path: `/${SITE}/goals?goal=g_signup` },
  // The first funnel drawn, four steps, with the builder under it.
  { name: '10-funnels', path: `/${SITE}/funnels?funnel=f_course` },
  // The fourth tab on Pages, the flow drawn.
  { name: '11-journeys', path: `/${SITE}/pages?pages=journeys` },
  // The site's own settings, three forms.
  { name: '12-settings', path: `/${SITE}/settings` },
];
const THEMES = ['light', 'dark'];

// Wide enough for the four card row, tall enough that the first screen of a
// report is the whole picture rather than the top of one.
const VIEWPORT = { width: 1440, height: 1100 };

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  colorScheme: 'light',
  timezoneId: 'Asia/Dhaka',
});

// One clock for every picture. Date.now and new Date() both answer the
// fixture's instant, so a range labelled "18 Sep" holds the numbers the fixture
// was written around.
await context.addInitScript(`{
  const frozen = ${NOW};
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [frozen] : args));
    }
    static now() {
      return frozen;
    }
  }
  globalThis.Date = FrozenDate;
}`);

const page = await context.newPage();
let taken = 0;

for (const theme of THEMES) {
  await page.goto(`${base}/`);
  await page.evaluate((choice) => localStorage.setItem('chokh:theme', choice), theme);

  for (const shot of PAGES) {
    await page.goto(`${base}${shot.path}`);
    await page.waitForSelector('nav[aria-label="Report"]');
    // Every skeleton gone: a picture of a loading state is a picture of
    // nothing, and it is the one a slow machine takes.
    await page.waitForFunction(() => document.querySelectorAll('[class*="skeleton"]').length === 0, {
      timeout: 15_000,
    });
    // No networkidle here: Realtime holds an event stream open, so the
    // network is never idle on that page and waiting for it is waiting for a
    // timeout. The skeletons being gone is the real gate.
    const name = `${shot.name}-${theme}`;
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    taken += 1;
    console.warn(`${file}`);

    const inRepo = README_SHOTS.get(name);
    if (inRepo !== undefined) {
      mkdirSync(README_OUT, { recursive: true });
      copyFileSync(file, join(README_OUT, inRepo));
      console.warn(`  also ${join(README_OUT, inRepo)}`);
    }
  }
}

await browser.close();
// The fixture this script started, stopped, or the command never returns: a
// child process keeps its parent running for as long as it runs.
fixture.stop();
console.warn(`\n${taken} screenshots in ${OUT}`);
if (taken !== PAGES.length * THEMES.length) {
  process.exit(1);
}
