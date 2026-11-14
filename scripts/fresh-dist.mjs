// A test run that would read a stale build says so and stops.
//
// The packages here consume each other through their built output: the server
// reads @chokh/store from its dist, the adapters read the conformance suite
// from it, packages/ee reads the server's. So a package's tests can only see
// what its dependencies were when they were last built. Edit the store's
// conformance suite, forget to build it, run the server's tests, and they pass
// against the old suite with nothing to say that the new cases never ran.
// That happened: 246 cases ran where 290 had been written, and the only clue
// was the count.
//
// CI cannot be fooled this way, because it builds before it tests. A laptop
// can, and a laptop is what a builder and a reviewer both lean on. So this is
// a vitest global setup: before the first test, for every workspace package
// the package under test depends on (and theirs), the newest source file must
// not be newer than the newest built file. If it is, the run fails with the
// command that puts it right.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');

function manifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

// Every workspace package by its name. One level under packages/, which is
// where everything that is built for another package to consume lives.
function workspace() {
  const byName = new Map();
  for (const name of readdirSync(PACKAGES)) {
    const dir = join(PACKAGES, name);
    if (existsSync(join(dir, 'package.json'))) {
      byName.set(manifest(dir).name, dir);
    }
  }
  return byName;
}

function workspaceDependencies(dir, byName) {
  const found = manifest(dir);
  const names = Object.entries({ ...found.dependencies, ...found.devDependencies })
    .filter(([, range]) => String(range).startsWith('workspace:'))
    .map(([name]) => name);
  return names.map((name) => byName.get(name)).filter((each) => each !== undefined);
}

// Not what the build leaves out: a test, or a helper only tests import.
const NOT_BUILT = /\.test\.tsx?$|\.test-utils\.ts$/;

function newest(dir, skip) {
  let latest = { at: 0, file: '' };
  if (!existsSync(dir)) {
    return latest;
  }
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      const inner = newest(path, skip);
      if (inner.at > latest.at) latest = inner;
    } else if (!skip.test(name) && stats.mtimeMs > latest.at) {
      latest = { at: stats.mtimeMs, file: path };
    }
  }
  return latest;
}

// The stale builds among everything `packageDir` depends on, each as a
// sentence. Empty when a run can be trusted.
export function staleBuilds(packageDir) {
  const byName = workspace();
  const seen = new Set();
  const queue = [...workspaceDependencies(packageDir, byName)];
  const stale = [];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    queue.push(...workspaceDependencies(dir, byName));
    // Only a package that is built and has a source to be behind.
    if (manifest(dir).scripts?.build === undefined || !existsSync(join(dir, 'src'))) continue;
    const source = newest(join(dir, 'src'), NOT_BUILT);
    const built = newest(join(dir, 'dist'), /^$/);
    const name = manifest(dir).name;
    if (built.at === 0) {
      stale.push(`${name} has not been built. Run: pnpm --filter ${name} build`);
    } else if (source.at > built.at) {
      stale.push(
        `${name} was built before ${relative(ROOT, source.file).split('\\').join('/')} last changed. Run: pnpm --filter ${name} build`,
      );
    }
  }
  return stale;
}

export default function setup() {
  const stale = staleBuilds(process.cwd());
  if (stale.length > 0) {
    throw new Error(
      [
        'These tests would run against a build older than its source, and could pass without testing what was changed:',
        ...stale.map((line) => `  ${line}`),
        'Or build everything: pnpm build',
      ].join('\n'),
    );
  }
}
