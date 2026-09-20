/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // A fixed port, so the preview configuration and anybody following the
    // README are looking at the same thing, and strict so a second one fails
    // loudly rather than quietly taking the next port up.
    port: 4120,
    strictPort: true,
    // In production this dashboard is served by the collector and every request
    // is same origin. In development it is a second process, so the API is
    // proxied rather than pointed at by an absolute URL: the session cookie is
    // httpOnly and SameSite=Lax, and a cross origin XHR would never carry it.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4100', changeOrigin: false },
      '/a.js': { target: 'http://127.0.0.1:4100', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No manifest. It was here for the size gate, which turned out not to want
    // one: scripts/size.mjs walks dist and weighs the files themselves, so the
    // budgets are measured whatever the build called things. Emitting it put a
    // description of the build graph into the directory the server hosts, for
    // nobody to read.
    rollupOptions: {
      output: {
        // React and the libraries around it change on their own schedule and
        // the application changes every commit, so they are separate files: a
        // deploy that touches one page does not make every visitor download the
        // framework again.
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
          // The world outlines, in a chunk of their own.
          //
          // Realtime and Geo both draw them and nothing else does, so left
          // alone Rollup would either duplicate them into both report chunks
          // or hoist them into a shared one with an unpredictable name. Named
          // here so the size gate can hold a budget for exactly this file: it
          // is the largest thing in the application and the easiest to grow
          // by accident.
          if (id.includes('/src/map/')) {
            return 'map';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
