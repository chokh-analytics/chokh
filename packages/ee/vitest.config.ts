import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The one file that drives a real browser has a config and a script of
    // its own (vitest.browser.config.ts, test:browser): it needs a browser
    // installed, which the job that runs every package's suite has not.
    exclude: ['src/**/*.browser.test.ts', 'node_modules/**'],
    // Before the first test: fail if a workspace package this one reads from
    // its build was built before its source last changed (scripts/fresh-dist.mjs
    // says what that once hid).
    globalSetup: ['../../scripts/fresh-dist.mjs'],
    env: {
      LOG_LEVEL: 'silent',
      // Invented, for the one case that needs an account another application
      // signs in. Never a real key.
      SSO_SECRET: 'test-sso-secret-not-a-real-key-000000',
    },
  },
});
