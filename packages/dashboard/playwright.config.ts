import { defineConfig, devices } from '@playwright/test';

// The smoke suite and the accessibility audit, against the built files.
//
// Against dist rather than the dev server, because what is being proved is what
// a person is served: a bundle that splits wrongly, a font that does not load
// or a route the static server cannot answer are all invisible in development.
// The fixture serves the same arrangement the collector does, a static tree
// plus /api on one origin.

const port = Number(process.env.PORT ?? 4112);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // A laptop screen. The phone layouts have their own cases inside the suite.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/fixture-server.mjs',
    url: `http://127.0.0.1:${port}/api/me`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
