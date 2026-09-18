import { defineConfig, devices } from '@playwright/test';

const port = 4111;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/fixture-server.mjs',
    url: `http://127.0.0.1:${port}/__collected`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
