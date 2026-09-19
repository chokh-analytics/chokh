import { defineConfig, devices } from '@playwright/test';

// The smoke suite and the accessibility audit, against the real server.
//
// Against dist and not the dev server, because what is proved is what a person
// is served: a bundle that splits wrongly, a font that does not load or a route
// the static host cannot answer are all invisible in development. And against
// packages/server itself rather than a mock of it, because the seams this
// suite exists for are the envelope, the session cookie, the redirect an
// expired session causes and the stream, and a mock is never wrong about any
// of them. Only storage is swapped, for a memory store, so nothing here needs
// MongoDB or Redis.

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
  projects: [
    // The session, signed in once. Every case after it starts with the cookie,
    // because the login route is rate limited by address and a suite that
    // signs in per case trips the limiter it is supposed to be proving.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'node e2e/server.mjs',
    url: `http://127.0.0.1:${port}/health`,
    // Never in CI: a stray process left on this port would be audited in place
    // of the build, and a green run would be a green run of something else.
    reuseExistingServer: process.env.CI === undefined,
    timeout: 60_000,
  },
});
