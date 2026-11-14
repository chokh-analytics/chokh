import { defineConfig } from 'vitest/config';

// The cases that drive a real browser, apart from the rest: run where a
// browser is installed (pnpm --filter @chokh/ee run test:browser), which in
// CI is the job that installs one for the dashboard's own suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.browser.test.ts'],
    globalSetup: ['../../scripts/fresh-dist.mjs'],
    env: {
      LOG_LEVEL: 'silent',
    },
  },
});
