// Writes the pages that come from the code into generated/, where the build
// reads them like any other page. They are committed, so a reader of the
// repository sees them and a review sees them change.
//
//   node scripts/generate.mjs           # write them
//   node scripts/generate.mjs --check   # fail if what is committed is not what the code says
//
// CI runs the check: a variable or a route added without its page changing
// fails the Docs workflow, naming the file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..', '..');
const GENERATED = join(ROOT, 'generated');
const check = process.argv.includes('--check');

function readJson(path) {
  return JSON.parse(readFileSync(join(REPO, path), 'utf8'));
}

// A list and not a table: three columns of which one is a sentence read badly
// on a phone, where the sentence gets a sliver of the width.
function table(entries) {
  return Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => `- **\`${name}\`**, default ${entry.default}. ${entry.about}.`)
    .join('\n');
}

export function environmentPage() {
  const core = readJson('packages/server/src/config/env.docs.json');
  const paid = readJson('packages/ee/src/env.docs.json');
  return `---
title: Environment variables
lead: Everything the server reads from its environment, and what each one does.
description: Every environment variable a Chokh install reads, with its default.
---

This page is generated from \`packages/server/src/config/env.docs.json\` and
\`packages/ee/src/env.docs.json\`, which a test holds to the variables the code
reads. To change a sentence here, change it there.

## The server

${table(core)}

## The paid features

Read only when \`packages/ee\` is loaded, and the features they configure run
only with a licence key that names them.

${table(paid)}
`;
}

// The API reference records the real server's answers first, once, for both
// the page and the OpenAPI file.
const { recordExamples } = await import('./api-reference.mjs');
const { apiPage, openApi } = await import('./api-page.mjs');
const examples = await recordExamples();

const PAGES = {
  'environment.md': environmentPage,
  'api.md': () => apiPage(examples),
  'openapi.json': () => `${JSON.stringify(openApi(examples), null, 2)}\n`,
};

let stale = 0;
mkdirSync(GENERATED, { recursive: true });
for (const [name, make] of Object.entries(PAGES)) {
  const path = join(GENERATED, name);
  const text = make();
  const committed = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : null;
  if (check) {
    if (committed !== text) {
      stale += 1;
      console.error(`generated/${name} is not what the code says. Run: pnpm --filter @chokh/docs site:generate`);
    }
  } else if (committed !== text) {
    writeFileSync(path, text);
    process.stdout.write(`wrote generated/${name}\n`);
  }
}
if (stale > 0) {
  process.exit(1);
}
process.stdout.write(`generated: ${Object.keys(PAGES).length} pages ${check ? 'match the code' : 'up to date'}\n`);
