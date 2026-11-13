// Builds one publishable package (@chokh/sdk-node, @chokh/react, @chokh/next) in
// both module formats, from the package's own directory:
//
//   dist/esm  ES modules, the package's own "type": "module"
//   dist/cjs  CommonJS, with a package.json saying so, because a backend is as
//             often CommonJS as not and so is many a React app's test runner
//
// Each with the .d.ts beside it, so a consumer resolves the types of the format
// it actually loaded. Two runs of tsc and nothing else: no bundler, so the
// files a consumer gets are the files that were written, and a 'use client'
// line at the top of a source file is still the top line of the built one.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const cwd = process.cwd();
const require = createRequire(join(cwd, 'package.json'));
const tsc = require.resolve('typescript/bin/tsc');

rmSync(join(cwd, 'dist'), { recursive: true, force: true });

for (const config of ['tsconfig.build.json', 'tsconfig.cjs.json']) {
  const run = spawnSync(process.execPath, [tsc, '-p', config], { cwd, stdio: 'inherit' });
  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }
}

mkdirSync(join(cwd, 'dist', 'cjs'), { recursive: true });
writeFileSync(join(cwd, 'dist', 'cjs', 'package.json'), '{\n  "type": "commonjs"\n}\n');
