import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Before the first test: fail if a workspace package this one reads from
    // its build was built before its source last changed (scripts/fresh-dist.mjs
    // says what that once hid).
    globalSetup: ['../../scripts/fresh-dist.mjs'],
    env: {
      LOG_LEVEL: 'silent',
    },
  },
});
