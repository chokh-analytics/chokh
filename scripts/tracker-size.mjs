// The tracker size gate. AGENTS.md rule 4: the tracker stays dependency-free
// and at most 3 KB gzipped. CI runs this after the build on every push.
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET_BYTES = 3 * 1024;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(repoRoot, 'packages/tracker/dist/a.js');

let raw;
try {
  raw = readFileSync(bundlePath);
} catch {
  console.error(
    `Tracker bundle not found at ${relative(repoRoot, bundlePath)}. Run "pnpm build" first.`,
  );
  process.exit(1);
}

const gzipped = gzipSync(raw, { level: 9 }).byteLength;
const percent = ((gzipped / BUDGET_BYTES) * 100).toFixed(1);
const summary = `tracker a.js: ${raw.byteLength} B raw, ${gzipped} B gzipped, budget ${BUDGET_BYTES} B (${percent}%)`;

// v.js and e.js are the optional vitals and error scripts. Neither has a budget
// of its own, because a site only pays for one when it asks for it, but their
// sizes are worth reading.
let vitals = '';
for (const [file, label] of [
  ['v.js', 'vitals'],
  ['e.js', 'errors'],
]) {
  try {
    const optionalRaw = readFileSync(resolve(repoRoot, 'packages/tracker/dist', file));
    vitals += `
     ${label} ${file} (optional, no budget): ${optionalRaw.byteLength} B raw, ${gzipSync(optionalRaw, { level: 9 }).byteLength} B gzipped`;
  } catch {
    // Not built: nothing to report.
  }
}

if (gzipped > BUDGET_BYTES) {
  console.error(`FAIL ${summary}${vitals}`);
  process.exit(1);
}

console.warn(`OK   ${summary}${vitals}`);
