// The demo, opened in Chromium, Firefox and WebKit (Safari's engine), each
// once as it is and once with the page's storage refused, the way a private
// window refuses it. For each: the banner says what the demo is, the
// dashboard draws the overview and Realtime from a link opened cold, a
// change is refused in the envelope, nothing on the page fails, and no
// request for /api leaves the browser, because nothing answers there.
//
//   pnpm --filter @chokh/docs site:demo-check            # every browser installed
//   DEMO_BROWSERS=chromium pnpm --filter @chokh/docs site:demo-check
import { chromium, firefox, webkit } from '@playwright/test';

import { DEMO_SITE } from '../../dashboard/e2e/demo-site.mjs';
import { site } from '../site.config.mjs';
import { startServer } from './serve.mjs';

const port = Number(process.env.PORT ?? 4122);
const base = `http://127.0.0.1:${port}${site.base}demo/`;
const ENGINES = { chromium, firefox, webkit };
const wanted = (process.env.DEMO_BROWSERS ?? 'chromium,firefox,webkit').split(',');

// What a private window does to storage, as near as a page can be told:
// every read and write throws.
const NO_STORAGE = `
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { get() { throw new DOMException('refused', 'SecurityError'); } });
  }
`;

const server = await startServer(port);
const failures = [];
try {
  for (const name of wanted) {
    const engine = ENGINES[name];
    if (engine === undefined) {
      throw new Error(`No browser called ${name}`);
    }
    const browser = await engine.launch();
    try {
      for (const storage of ['storage', 'no storage']) {
        const context = await browser.newContext();
        if (storage === 'no storage') {
          await context.addInitScript(NO_STORAGE);
        }
        const page = await context.newPage();
        const problems = [];
        const left = [];
        page.on('pageerror', (error) => problems.push(error.message));
        page.on('request', (request) => {
          if (new URL(request.url()).pathname.startsWith('/api/')) {
            left.push(request.url());
          }
        });
        const label = `${name}, ${storage}`;
        try {
          await page.goto(base);
          await page.getByText('A demo with invented data.').waitFor({ timeout: 20_000 });
          await page.getByRole('link', { name: 'Overview' }).first().waitFor({ timeout: 20_000 });
          if (!page.url().endsWith(`/demo/${DEMO_SITE.id}`)) {
            problems.push(`opened at ${page.url()}, not the site's overview`);
          }
          await page.getByText(DEMO_SITE.name).first().waitFor({ timeout: 10_000 });
          // A page opened cold, as a shared link opens it.
          await page.goto(`${base}${DEMO_SITE.id}/realtime`);
          await page.getByText('Live', { exact: false }).first().waitFor({ timeout: 20_000 });
          const refused = await page.evaluate(async () => {
            const response = await fetch('/api/sites/s_demo/goals', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ kind: 'page', name: 'x', match: '/' }),
            });
            return { status: response.status, code: (await response.json()).error?.code };
          });
          if (refused.status !== 403 || refused.code !== 'DEMO_READ_ONLY') {
            problems.push(`a change answered ${refused.status} ${refused.code}`);
          }
        } catch (error) {
          problems.push(error instanceof Error ? error.message.split('\n')[0] : String(error));
        }
        if (left.length > 0) {
          problems.push(`${left.length} requests for /api left the browser, the first ${left[0]}`);
        }
        process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${label}${problems.length === 0 ? '' : `: ${problems.join('; ')}`}\n`);
        if (problems.length > 0) {
          failures.push(label);
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
if (failures.length > 0) {
  console.error(`The demo failed in: ${failures.join(', ')}`);
  process.exit(1);
}
process.stdout.write(`demo: ${wanted.length * 2} runs, every one whole\n`);
