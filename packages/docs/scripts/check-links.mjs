// Every link inside the built site arrives, anchors included. Run after the
// build; fails with one line per link that does not.
//
//   pnpm --filter @chokh/docs site && pnpm --filter @chokh/docs site:links
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { site } from '../site.config.mjs';
import { checkLinks, readFiles, readSite } from '../src/links.mjs';

const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist');
if (!existsSync(DIST)) {
  console.error('There is no build to check: run the site script first.');
  process.exit(1);
}
const pages = readSite(DIST, site.base);
const { problems, external } = checkLinks(pages, readFiles(DIST, site.base), site.base);
const internal = [...pages.values()].reduce((sum, page) => sum + page.links.length, 0) - external;
if (problems.length > 0) {
  console.error(`${problems.length === 1 ? '1 link that does' : `${problems.length} links that do`} not arrive:\n${problems.join('\n')}`);
  process.exit(1);
}
process.stdout.write(
  `links: ${pages.size} pages, ${internal} links inside the site all arrive, ${external} to elsewhere not fetched\n`,
);
