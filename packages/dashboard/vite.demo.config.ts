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
    // The fixture takes the functions of the journeys, retention and health
    // reports from the store's index, which also holds the server's code
    // (node:crypto among it). In the browser, the index means the three files
    // those functions live in (e2e/store-browser.mjs), which need nothing but
    // the contract and the calendar the dashboard already reads.
    alias: [
      {
        find: /^@chokh\/store$/,
        replacement: fileURLToPath(new URL('./e2e/store-browser.mjs', import.meta.url)),
      },
    ],
  },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    rollupOptions: { input: 'demo.html' },
  },
});
