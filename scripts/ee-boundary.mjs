// The line between the MIT core and packages/ee, checked rather than remembered.
//
// ADR-0073 decision 4: a ticket marked ee never lands outside packages/ee, and
// a ticket marked core never reads the licence key. Review refuses a crossing
// in either direction, and this is what makes the refusal mechanical rather
// than a thing somebody has to notice in a diff at eleven at night.
//
// It matters because the crossing cannot be undone. A feature released under
// MIT is free for ever: a later version can carry a different licence, but the
// version already published cannot be recalled. So a paid feature that lands in
// packages/server by accident is not a bug to fix next week, it is a feature
// given away.
//
// Three rules, in the order they are worth breaking:
//
//   1. No file outside packages/ee reads CHOKH_LICENSE_KEY, and no file outside
//      packages/ee, the docs and one named string table even names it. The
//      core not reading the key is what makes "the core is free in full" true.
//      The one named exception is the dashboard's messages file, which tells an
//      operator which variable to look at when their key is wrong. That is a
//      sentence on a screen and not a read, and the read patterns below apply
//      to it like everything else.
//   2. Only one file in the core may reach into packages/ee, by name or by
//      path: packages/server/src/lib/load-extensions.ts, whose whole job is
//      that. If a second file ever needs the exemption, the seam is in the
//      wrong place and the answer is not another row here.
//   3. No core package may depend on @chokh/ee. The dependency runs the other
//      way, and a cycle would leave pnpm with no honest build order.
//
// ESLint enforces the second rule too, so a developer sees it in the editor.
// This runs in CI as well, because a build that skipped lint is a build that
// skipped that.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The one file allowed to know packages/ee exists, and the documents whose job
// is to describe the line rather than to cross it.
const LOADER = 'packages/server/src/lib/load-extensions.ts';
const DOCS = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'CLA.md',
  'AGENTS.md',
  'CLAUDE.md',
  'LICENSE',
  'scripts/ee-boundary.mjs',
  'eslint.config.js',
  'Dockerfile',
  'docker-compose.yml',
  '.github/workflows/ci.yml',
]);

// Naming the variable in a message an operator reads is the actionable half of
// "your licence key is not a licence key". It is a string in a table of
// strings, and the read check below still covers it.
const NAMES_KEY = new Set(['packages/dashboard/src/messages/en.ts']);

// Reading it: off process.env by either syntax, or declared as a key in an
// environment schema. packages/ee/src/license/env.ts is the only file in the
// repository that may do this, and it is not walked here.
const READS_KEY =
  /process\.env\s*(?:\.\s*CHOKH_LICENSE_KEY|\[\s*['"`]CHOKH_LICENSE_KEY['"`]\s*\])|(?:^|[^\w'"`])CHOKH_LICENSE_KEY\s*:/m;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test-results', 'lighthouse', 'screenshots']);
const SOURCE = /\.(ts|tsx|mjs|js|json)$/;

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, found);
      continue;
    }
    found.push(relative(root, path).replace(/\\/g, '/'));
  }
  return found;
}

const files = walk(root);
const failures = [];

function inCore(path) {
  return path.startsWith('packages/') && !path.startsWith('packages/ee/') && !DOCS.has(path);
}

// Rule 1. The key.
for (const path of files) {
  if (!SOURCE.test(path) || path.startsWith('packages/ee/') || DOCS.has(path)) {
    continue;
  }
  const source = readFileSync(join(root, path), 'utf8');
  if (!source.includes('CHOKH_LICENSE_KEY')) {
    continue;
  }
  if (READS_KEY.test(source)) {
    failures.push(
      `${path} reads CHOKH_LICENSE_KEY. Only packages/ee/src/license/env.ts may; the core never reads the licence key.`,
    );
    continue;
  }
  if (!NAMES_KEY.has(path)) {
    failures.push(
      `${path} names CHOKH_LICENSE_KEY. Outside packages/ee only the dashboard's messages file may, to tell an operator which variable to look at.`,
    );
  }
}

// Rule 2. The one door.
const REACHES_EE = /(from|import|require)\s*\(?\s*['"`][^'"`]*(@chokh\/ee|packages\/ee|\.\.\/ee\/)/;
for (const path of files) {
  if (!SOURCE.test(path) || !inCore(path) || path === LOADER) {
    continue;
  }
  const source = readFileSync(join(root, path), 'utf8');
  if (REACHES_EE.test(source)) {
    failures.push(
      `${path} imports from packages/ee. Only ${LOADER} may, and if a second file needs to, the seam is in the wrong place.`,
    );
  }
}

// Rule 3. The dependency direction.
for (const path of files) {
  if (!path.endsWith('/package.json') || path.startsWith('packages/ee/')) {
    continue;
  }
  const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (manifest[field]?.['@chokh/ee'] !== undefined) {
      failures.push(
        `${path} lists @chokh/ee under ${field}. packages/ee depends on the core and never the other way, and a cycle leaves pnpm with no honest build order.`,
      );
    }
  }
}

// And the loader is still there, so that deleting it does not turn this whole
// check into a script that passes because it found nothing to look at.
if (!files.includes(LOADER)) {
  failures.push(`${LOADER} is gone. That file is the seam, and this check is meaningless without it.`);
}

if (failures.length > 0) {
  console.error(`FAIL the ee boundary, ${failures.length} crossing${failures.length === 1 ? '' : 's'}:`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.warn(`OK   the ee boundary holds, across ${files.length} files.`);
