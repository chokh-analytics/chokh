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
      // A placeholder, never a real key. Set here because the SSO route refuses
      // everything without one, which is the right default and not what the SSO
      // cases are about.
      SSO_SECRET: 'test-sso-secret-not-a-real-key-000000',
    },
  },
});
