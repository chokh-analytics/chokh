// The size gate for the three published packages: what each adds to a
// consumer's bundle, minified and gzipped, with what the consumer already has
// left out (react, react-dom, next, Node's own modules). @chokh/next is measured
// with the @chokh/react it depends on, because a consumer gets both. CI runs it
// after the build on every push, beside the tracker's gate; a budget moves
// only with a measurement in the commit that moves it.
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

// The report goes to stdout; lint keeps console for warnings and errors.
const say = (line) => process.stdout.write(`${line}\n`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = [
  { name: '@chokh/sdk-node', entry: 'packages/sdk-node/dist/esm/index.js', budget: 4096, platform: 'node' },
  { name: '@chokh/react', entry: 'packages/react/dist/esm/index.js', budget: 1024, platform: 'browser' },
  { name: '@chokh/next', entry: 'packages/next/dist/esm/index.js', budget: 1536, platform: 'browser' },
  { name: '@chokh/next/config', entry: 'packages/next/dist/esm/config.js', budget: 1024, platform: 'node' },
  { name: '@chokh/next/collect', entry: 'packages/next/dist/esm/collect.js', budget: 1536, platform: 'node' },
];

let failed = false;
for (const pkg of PACKAGES) {
  const entry = resolve(root, pkg.entry);
  if (!existsSync(entry)) {
    console.error(`${pkg.name}: ${pkg.entry} is not built. Run "pnpm build" first.`);
    process.exit(1);
  }
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    write: false,
    format: 'esm',
    platform: pkg.platform,
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'next', 'next/*', 'node:*'],
    // The 'use client' directive is kept by a consumer's bundler; here it is
    // only a warning about a directive in a bundle, which says nothing about size.
    logLevel: 'error',
  });
  const raw = result.outputFiles[0].contents;
  const gzipped = gzipSync(raw, { level: 9 }).byteLength;
  const over = gzipped > pkg.budget;
  failed ||= over;
  say(
    `${over ? 'OVER ' : ''}${pkg.name}: ${raw.byteLength} B minified, ${gzipped} B gzipped, budget ${pkg.budget} B (${((gzipped / pkg.budget) * 100).toFixed(1)}%)`,
  );
}

if (failed) {
  console.error('A package is over its budget. Make it smaller, or move the budget in the commit that measures why.');
  process.exit(1);
}
