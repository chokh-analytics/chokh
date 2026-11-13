import { defineConfig } from 'vitest/config';

// The unit cases on React 19. react-18/ runs the same files on React 18, the
// oldest major the peer range claims; each case reads React.version, so either
// run proves which React it loaded.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    env: { CHOKH_EXPECT_REACT: '19' },
  },
});
