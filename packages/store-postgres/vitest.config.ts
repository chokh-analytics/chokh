import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One PostgreSQL for the whole run: CI's service container when
    // CHOKH_TEST_DATABASE_URL names it, otherwise one started here and stopped
    // when the run ends. Each test file works in a schema of its own.
    globalSetup: ['src/testing/global-setup.ts'],
    // Starting a database takes a while on a cold machine, and the conformance
    // suite seeds a world in a single beforeAll.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
