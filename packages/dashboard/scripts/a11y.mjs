// Accessibility, audited rather than asserted.
//
// The component tests say a table has a caption and a button has a name. This
// says the whole assembled page passes an audit nobody here wrote: contrast in
// both palettes, heading order across the shell and the report together, every
// control reachable, every landmark named. A score of 1 is the bar, because
// anything less is a list of things somebody decided not to fix.
//
// Both themes, because half the colour decisions in this product exist in only
// one of them, and a dark palette that fails contrast fails it quietly.
//
// The guard is the whole reason this file is longer than a one liner:
// Lighthouse scores a blank page 1 on accessibility. An audit of a dashboard
// that failed to boot is a perfect score and a broken product, so every run has
// to prove it audited a page with the report in it, and says how many audits
// actually ran.
//
// It is a script rather than a Playwright test because Lighthouse's config
// pulls in a dependency that is shipped as TypeScript, and Playwright's own
// transform trips over it. Plain node loads the built copy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';

import { startFixture } from '../e2e/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'lighthouse');
const port = Number(process.env.PORT ?? 4112);
// The real server, not the screenshot fixture: an accessibility score over a
// mock's markup is a score for the mock.
const fixture = await startFixture(port, 'real');
const base = fixture.base;
const DEBUG_PORT = 9222;

const PAGES = [
  { name: 'overview', path: '/s_demo' },
  { name: 'realtime', path: '/s_demo/realtime' },
  // The funnel the server seeds, and the builder under it.
  { name: 'funnels', path: '/s_demo/funnels' },
];
const THEMES = ['light', 'dark'];

// What has to be on screen for the audit to count. The navigation is in the
// shell, so a page that rendered it booted, routed and painted.
const GUARD = 'nav[aria-label="Report"]';

async function audit(browser, page, theme) {
  const tab = await browser.newPage();
  // The real server needs a session before it serves anything but the shell.
  await tab.request.post(`${base}/api/auth/login`, {
    data: { email: 'owner@chokh.test', password: 'a-long-enough-password' },
  });
  // The theme is a choice in localStorage that a script in index.html applies
  // before the first paint, so it is written on the origin and the page then
  // opened, exactly as a returning visitor arrives.
  await tab.goto(`${base}/`);
  await tab.evaluate((choice) => localStorage.setItem('chokh:theme', choice), theme);
  await tab.goto(`${base}${page.path}`);
  await tab.waitForSelector(GUARD);
  const painted = await tab.locator(GUARD).count();

  const result = await lighthouse(
    `${base}${page.path}`,
    { port: DEBUG_PORT, output: 'json', logLevel: 'error' },
    {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['accessibility'],
        formFactor: 'desktop',
        screenEmulation: { disabled: true },
      },
    },
  );
  await tab.close();

  const report = result?.lhr;
  const audits = Object.values(report?.audits ?? {});
  const applicable = audits.filter((one) => one.score !== null);
  return {
    page: page.name,
    theme,
    url: report?.finalDisplayedUrl ?? `${base}${page.path}`,
    accessibility: report?.categories?.accessibility?.score ?? null,
    // Three numbers rather than one, so a green line is checkable: a score of 1
    // over two applicable audits is not the same claim as a score of 1 over
    // thirty.
    auditsRun: audits.length,
    auditsApplicable: applicable.length,
    rendered: painted,
    failed: applicable.filter((one) => one.score < 1).map((one) => one.id),
  };
}

const browser = await chromium.launchPersistentContext('', {
  args: [`--remote-debugging-port=${DEBUG_PORT}`],
});

const results = [];
try {
  for (const page of PAGES) {
    for (const theme of THEMES) {
      results.push(await audit(browser, page, theme));
    }
  }
} finally {
  await browser.close();
  fixture.stop();
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'accessibility.json'), `${JSON.stringify(results, null, 2)}\n`);

let bad = 0;
for (const result of results) {
  const problems = [];
  if (result.rendered < 1) {
    problems.push('the page had no dashboard in it');
  }
  if (result.auditsApplicable < 20) {
    problems.push(`only ${result.auditsApplicable} audits applied`);
  }
  if (result.accessibility !== 1) {
    problems.push(`scored ${result.accessibility}: ${result.failed.join(', ')}`);
  }
  const line = `${result.page} ${result.theme}: ${result.accessibility} over ${result.auditsApplicable} applicable audits`;
  if (problems.length === 0) {
    console.warn(`OK   ${line}`);
  } else {
    bad += 1;
    console.warn(`FAIL ${line}\n     ${problems.join('\n     ')}`);
  }
}

console.warn(`\nwritten to ${join(OUT, 'accessibility.json')}`);
process.exit(bad === 0 ? 0 : 1);
