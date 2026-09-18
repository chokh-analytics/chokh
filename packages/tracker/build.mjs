// Builds the tracker into one dependency-free IIFE, and the optional vitals
// script beside it. The size of a.js is asserted by scripts/tracker-size.mjs
// in CI.
import { build } from 'esbuild';

const shared = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018'],
  legalComments: 'none',
  logLevel: 'info',
};

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/a.js' });
await build({ ...shared, entryPoints: ['src/vitals.ts'], outfile: 'dist/v.js' });
