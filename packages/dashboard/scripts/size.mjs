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
  // Measured 2026-09-24 at 33,885 B after the segments popover and the save
  // form joined the range bar, 931 B under the line. Raised to 35 KB the same
  // day by the commit that spent it, the marks on the chart: measured at
  // 34,907 B with the guides, the glyphs, the hover lines and the hidden list
  // in TimeChart, which the Overview shares with the shell. Raised to 37 KB
  // the same day by the commit that spent it, the Alerts page: measured at
  // 37,220 B, of which the page itself is a lazy chunk and what landed here
  // is its strings, because every string lives in the one messages file the
  // shell carries (rule 8), plus the eleventh destination and its key.
  // Raised to 38 KB on 2026-09-25 by the commit that spent it, every report
  // as a file (AN-RPT01): measured at 38,043 B with the Download control in
  // the card's foot, the Overview's four cards and its chart head, and the
  // seven strings the control reads.
  // Raised to 39 KB on 2026-09-25 by the commit that spent it, the embed:
  // measured at 38,941 B, the five strings of the Settings card's two
  // snippets, which live in the one messages file the shell carries.
  { name: 'app', pattern: /^index-.*\.js$/, bytes: 39 * 1024 },
  // The world outlines, downloaded by Realtime and Geo and by nothing else.
  // Measured 2026-09-20 at 39,923 B.
  { name: 'map', pattern: /^map-.*\.js$/, bytes: 44 * 1024 },
  // One chunk per report, plus the pieces more than one report shares.
  // Measured 2026-09-20 at 12,591 B for the eight together, the largest being
  // Realtime at 3,256 B. Raised from 20 KB on 2026-09-23 by the commit that
  // spent it, the Funnels page: measured at 21,493 B for twelve chunks, the
  // largest now Funnels at 3,615 B with its list, builder and delete. With
  // the funnel drawn, measured the same day at 22,430 B, Funnels 4,540 B.
  // Raised again to 26 KB by the commit that spent it, Journeys: measured at
  // 25,248 B for thirteen chunks, the flow its own chunk at 2,440 B and Pages
  // 1,985 B with the fourth tab, the import that fetches it and the
  // engagement table in a box that scrolls on a phone. Raised to 30 KB on
  // 2026-09-24 by the commit that spent it, the settings page: measured at
  // 27,803 B for fourteen chunks, Settings its own chunk with three forms.
  // Raised to 34 KB the same day by the commit that spent it, the Alerts
  // page: measured at 33,359 B for sixteen chunks, Alerts its own chunk with
  // the list, the test, the delete and a form per kind, and the annotations
  // panel (Notes) its own at about 2 KB.
  // Raised to 38 KB on 2026-09-25 by the commit that spent it, the shared
  // page (AN-RPT01): measured at 37,853 B for seventeen chunks, Share its own
  // chunk at about 4 KB with the head, the unlock form, the presets, the
  // tiles, the chart and the four cards over the Overview's own components.
  // Raised to 39 KB on 2026-09-25 by the commit that spent it, the digests
  // section on the Alerts page: measured at 39,649 B, the list with what
  // happened last, send now, delete and the form, in the Alerts chunk.
  { name: 'routes', pattern: /\.js$/, bytes: 39 * 1024 },
  // Raised to 15 KB on 2026-09-24 by the commit that spent it, the Alerts
  // page: measured at 14,994 B, Alerts 723 B and the annotations panel 482 B.
  // Raised to 16 KB on 2026-09-25 by the commit that spent it, the shared
  // page: measured at 15,889 B, Share 797 B and the Settings card's rules.
  { name: 'css', pattern: /\.css$/, bytes: 16 * 1024 },
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
