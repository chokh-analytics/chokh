// Builds the tracker into one dependency-free IIFE. The size of the output is
// asserted by scripts/tracker-size.mjs in CI.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/a.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018'],
  legalComments: 'none',
  logLevel: 'info',
});
