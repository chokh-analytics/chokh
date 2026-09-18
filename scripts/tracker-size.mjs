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

// v.js is the optional vitals script. It has no budget of its own, because a
// site only pays for it when it asks for it, but its size is worth reading.
const vitalsPath = resolve(repoRoot, 'packages/tracker/dist/v.js');
let vitals = '';
try {
  const vitalsRaw = readFileSync(vitalsPath);
  vitals = `
     vitals v.js (optional, no budget): ${vitalsRaw.byteLength} B raw, ${gzipSync(vitalsRaw, { level: 9 }).byteLength} B gzipped`;
} catch {
  vitals = '';
}

if (gzipped > BUDGET_BYTES) {
  console.error(`FAIL ${summary}${vitals}`);
  process.exit(1);
}

console.warn(`OK   ${summary}${vitals}`);
