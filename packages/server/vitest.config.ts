import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      LOG_LEVEL: 'silent',
      // inject() arrives from 127.0.0.1, so trusting the loopback lets a test
      // say which address a visitor came from.
      TRUST_PROXY: '127.0.0.1/32,::1/128',
    },
  },
});
