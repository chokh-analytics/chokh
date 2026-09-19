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
    // The size gate reads this to know what each file weighs, so the budgets in
    // scripts/size.mjs are measured rather than estimated.
    manifest: true,
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
