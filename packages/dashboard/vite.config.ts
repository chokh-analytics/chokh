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
  },
});
