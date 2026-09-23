// The dashboard size gate, the tracker's gate applied to a bigger thing.
//
// A dashboard is the first screenshot a developer sees and the first thing they
// wait for. The budgets below are per group of emitted files, gzipped where
// gzip does anything, and they are set from what the build actually weighed
// rather than from a guess, so a number moving means a decision was made rather
// than that something crept in.
//
// Fonts count. They are woff2, which is already compressed, so what is on disk
// is what goes down the wire, and a privacy product that self hosts its fonts
// has to be honest about carrying them.
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Matched against the emitted file name, first match wins. A file that matches
// nothing falls into "other", which has a budget of its own so that nothing can
// arrive unmeasured.
//
// One budget per group the build actually has, which is what code splitting
// bought: before it, every line of every report sat in one "app" figure and a
// map nobody had opened was part of what the sign-in page weighed. Now the
// entry chunk is what a first paint costs, the routes are what opening a
// report costs, and the map is its own line because it is the largest thing
// here and the easiest to grow by accident.
const BUDGETS = [
  // Measured 2026-09-19: 83,375 B, being React 19 and React DOM at 69 KB,
  // TanStack Query at about 12 and wouter at about 2. Raised from 72 KB in the
  // commit that added the last two, which is the rule: a budget moves in the
  // diff that spends it, never quietly.
  { name: 'vendor', pattern: /^vendor-.*\.js$/, bytes: 86 * 1024 },
  // The entry chunk: the shell, the Overview and everything they share.
  // Measured 2026-09-20 at 26,709 B, down from 74 KB when every report was in
  // it. The last 410 B are the licence read and the "part of Chokh Pro" label,
  // which live in the shell because the account menu names the licence.
  { name: 'app', pattern: /^index-.*\.js$/, bytes: 34 * 1024 },
  // The world outlines, downloaded by Realtime and Geo and by nothing else.
  // Measured 2026-09-20 at 39,923 B.
  { name: 'map', pattern: /^map-.*\.js$/, bytes: 44 * 1024 },
  // One chunk per report, plus the pieces more than one report shares.
  // Measured 2026-09-20 at 12,591 B for the eight together, the largest being
  // Realtime at 3,256 B. Raised from 20 KB on 2026-09-23 by the commit that
  // spent it, the Funnels page: measured at 21,493 B for twelve chunks, the
  // largest now Funnels at 3,615 B with its list, builder and delete.
  { name: 'routes', pattern: /\.js$/, bytes: 24 * 1024 },
  { name: 'css', pattern: /\.css$/, bytes: 14 * 1024 },
  // Measured 2026-09-19: the variable sans is 45,712 B and the mono is 14,708.
  { name: 'fonts', pattern: /\.woff2?$/, bytes: 62 * 1024 },
  { name: 'html', pattern: /\.html$/, bytes: 4 * 1024 },
  { name: 'other', pattern: /.*/, bytes: 40 * 1024 },
];

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(dashboardRoot, 'dist');

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
      continue;
    }
    found.push(path);
  }
  return found;
}

let files;
try {
  files = walk(distRoot);
} catch {
  console.error(
    `Dashboard build not found at ${relative(dashboardRoot, distRoot)}. Run "pnpm build" first.`,
  );
  process.exit(1);
}

if (files.length === 0) {
  console.error('The dashboard build is empty, which is not a passing size gate.');
  process.exit(1);
}

const groups = new Map(BUDGETS.map((budget) => [budget.name, { ...budget, bytes_used: 0, files: [] }]));

for (const path of files) {
  const name = path.slice(distRoot.length + 1).replace(/\\/g, '/');
  const raw = readFileSync(path);
  // Fonts and images are already compressed, so gzipping them again measures
  // the gzip implementation rather than the file.
  const compressible = /\.(js|css|html|json|svg|map)$/.test(name);
  const size = compressible ? gzipSync(raw, { level: 9 }).byteLength : raw.byteLength;
  const budget = BUDGETS.find((candidate) => candidate.pattern.test(name.split('/').pop()));
  const group = groups.get(budget.name);
  group.bytes_used += size;
  group.files.push(`${name} ${size} B`);
}

const rows = [...groups.values()].filter((group) => group.files.length > 0);
const width = Math.max(...rows.map((row) => row.name.length));
const failures = [];

const table = rows
  .map((row) => {
    const percent = ((row.bytes_used / row.bytes) * 100).toFixed(1);
    const status = row.bytes_used > row.bytes ? 'FAIL' : 'OK  ';
    if (row.bytes_used > row.bytes) {
      failures.push(`${row.name}: ${row.bytes_used} B of ${row.bytes} B\n    ${row.files.join('\n    ')}`);
    }
    return `  ${status} ${row.name.padEnd(width)}  ${String(row.bytes_used).padStart(7)} B of ${String(row.bytes).padStart(7)} B  (${percent}%)`;
  })
  .join('\n');

const total = rows.reduce((sum, row) => sum + row.bytes_used, 0);
const summary = `dashboard, gzipped where it compresses:\n${table}\n       ${'total'.padEnd(width)}  ${String(total).padStart(7)} B`;

if (failures.length > 0) {
  console.error(`FAIL ${summary}\n\n${failures.join('\n')}`);
  process.exit(1);
}

console.warn(`OK   ${summary}`);
