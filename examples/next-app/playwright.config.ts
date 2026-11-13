import { defineConfig, devices } from '@playwright/test';

// Two servers: the real Chokh server (memory store, the built tracker), and this
// app built and started in production mode against it, the way a deployment
// runs. The app's collect route signs the visitor's address with the same
// secret the Chokh server checks.
const chokh = 'http://127.0.0.1:4115';
const secret = 'chokh-e2e-proxy-secret-not-for-production';
const port = 3215;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // What a host's edge would say the visitor's address is; the route signs it
    // and the collector, trusting the signature, stores it.
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.9' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/chokh-server.mjs',
      url: 'http://127.0.0.1:4116/',
      reuseExistingServer: false,
      timeout: 30_000,
      env: { CHOKH_PROXY_SECRET: secret },
    },
    {
      command: `pnpm exec next build && pnpm exec next start -p ${port} -H 127.0.0.1`,
      url: `http://127.0.0.1:${port}/`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: { CHOKH_URL: chokh, CHOKH_PROXY_SECRET: secret, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
