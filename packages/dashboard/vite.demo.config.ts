import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The demo build: the dashboard over the frozen fixture, answered in the
// page (src/demo/), under the base path the docs site serves it from. Built
// into dist-demo/, apart from the dashboard the server serves, which never
// carries any of this.
//
//   DEMO_BASE=/demo/ pnpm --filter @chokh/dashboard build:demo
const base = process.env.DEMO_BASE ?? '/demo/';

export default defineConfig({
  plugins: [react()],
  base,
  resolve: {
    // The fixture takes four functions of the journeys report from the
    // store's index, which also holds the server's code (node:crypto among
    // it). In the browser, the index means the one file those four live in,
    // which needs nothing but the contract the dashboard already reads.
    alias: [
      {
        find: /^@chokh\/store$/,
        replacement: fileURLToPath(new URL('../store/src/journey.ts', import.meta.url)),
      },
    ],
  },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    rollupOptions: { input: 'demo.html' },
  },
});
