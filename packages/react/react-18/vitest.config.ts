import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// @chokh/react's own unit cases, run again on React 18.3.1.
//
// The cases live in ../src and import 'react' from there, which would find the
// package's own React 19, so every react and react-dom import is pointed at the
// copies this project installed. react-dom 18 requires 'react' for itself and
// pnpm resolved that peer for this project, so it reaches the same React 18.
// Each case reads React.version, so a run that quietly loaded 19 fails.
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const reactDir = dirname(require.resolve('react/package.json'));
const reactDomDir = dirname(require.resolve('react-dom/package.json'));

export default defineConfig({
  root: resolve(here, '..'),
  resolve: {
    alias: [
      { find: /^react$/, replacement: reactDir },
      { find: /^react\/(.*)$/, replacement: `${reactDir}/$1` },
      { find: /^react-dom$/, replacement: reactDomDir },
      { find: /^react-dom\/(.*)$/, replacement: `${reactDomDir}/$1` },
    ],
  },
  test: {
    name: 'react-18',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    env: { CHOKH_EXPECT_REACT: '18' },
  },
});
