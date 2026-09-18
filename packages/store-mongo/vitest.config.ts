import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // A downloaded mongod has to start before the first test runs, and the
    // conformance suite seeds a world in a single beforeAll.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
