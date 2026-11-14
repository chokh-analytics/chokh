// Accessibility, audited: every page of the built docs, at a phone's width and
// a desktop's, in both themes, by Lighthouse (which runs axe). A score of 1 is
// the bar, as it is for the dashboard (packages/dashboard/scripts/a11y.mjs,
// whose shape this follows), and a run proves it audited a page with the
// words on it: Lighthouse scores a blank page 1.
//
//   pnpm --filter @chokh/docs site && pnpm --filter @chokh/docs site:a11y
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';

import { site } from '../site.config.mjs';
import { startServer } from './serve.mjs';

const port = Number(process.env.PORT ?? 4121);
const base = `http://127.0.0.1:${port}`;
const DEBUG_PORT = 9223;

const PAGES = [
  { name: 'home', path: site.base },
  { name: 'licence', path: `${site.base}licence/` },
  // The page an unknown address gets. By its own file, since Lighthouse
  // will not audit an answer of 404.
  { name: 'not found', path: `${site.base}404.html` },
];
const THEMES = ['light', 'dark'];
const WIDTHS = [
  { name: 'phone', formFactor: 'mobile', screenEmulation: { mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false } },
  { name: 'desktop', formFactor: 'desktop', screenEmulation: { mobile: false, width: 1280, height: 860, deviceScaleFactor: 1, disabled: false } },
];
// A page with a title, a lead and a footer applies well over this many; a
// blank page applies about ten.
const MIN_AUDITS = 18;
const GUARD = 'main h1';

const server = await startServer(port);
const browser = await chromium.launchPersistentContext('', {
  args: [`--remote-debugging-port=${DEBUG_PORT}`],
});

const results = [];
try {
  for (const page of PAGES) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const tab = await browser.newPage();
        // The theme is a choice the page applies before its first paint, as a
        // returning reader's is.
        await tab.goto(`${base}${site.base}`);
        // Runs in the page, where globalThis is the window.
        await tab.evaluate((choice) => globalThis.localStorage.setItem('chokh:theme', choice), theme);
        await tab.goto(`${base}${page.path}`);
        const painted = await tab.locator(GUARD).count();
        const result = await lighthouse(
          `${base}${page.path}`,
          { port: DEBUG_PORT, output: 'json', logLevel: 'error' },
          {
            extends: 'lighthouse:default',
            settings: { onlyCategories: ['accessibility'], formFactor: width.formFactor, screenEmulation: width.screenEmulation },
          },
        );
        await tab.close();
        const audits = Object.values(result?.lhr?.audits ?? {});
        const applicable = audits.filter((one) => one.score !== null);
        results.push({
          page: page.name,
          theme,
          width: width.name,
          score: result?.lhr?.categories?.accessibility?.score ?? null,
          applicable: applicable.length,
          painted,
          failed: applicable.filter((one) => one.score < 1).map((one) => one.id),
        });
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

let bad = 0;
for (const row of results) {
  const ok = row.score === 1 && row.painted > 0 && row.applicable >= MIN_AUDITS;
  if (!ok) {
    bad += 1;
  }
  process.stdout.write(
    `${ok ? 'ok  ' : 'FAIL'} ${row.page}, ${row.theme}, ${row.width}: score ${row.score}, ${row.applicable} audits applied${row.failed.length > 0 ? `, failed: ${row.failed.join(', ')}` : ''}${row.painted === 0 ? ', the page did not paint' : ''}\n`,
  );
}
if (bad > 0) {
  console.error(`${bad} of ${results.length} audits did not pass`);
  process.exit(1);
}
process.stdout.write(`a11y: ${results.length} audits, every one a score of 1\n`);
