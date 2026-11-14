// Builds the docs site into dist/: one HTML file per page, one script and one
// stylesheet with hashed names, the two font files, a search index and a 404
// page. A static tree, served as it is by any host.
//
//   pnpm --filter @chokh/docs site            # served under /chokh/
//   DOCS_BASE=/ pnpm --filter @chokh/docs site
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import MiniSearch from 'minisearch';

import { site } from '../site.config.mjs';
import { createRenderer, splitFrontMatter } from '../src/markdown.mjs';
import { checkNav } from '../src/nav.mjs';
import { renderPage } from '../src/page.mjs';
import { SEARCH_OPTIONS } from '../src/search-options.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CONTENT = join(ROOT, 'content');
const DIST = join(ROOT, 'dist');
const started = Date.now();

// Every page, read once, checked against the navigation both ways.
const files = readdirSync(CONTENT).filter((name) => name.endsWith('.md'));
const listed = checkNav(
  site.nav,
  files.map((name) => name.slice(0, -3)),
);

const renderer = createRenderer({ base: site.base });
const pages = listed.map((slug) => {
  const source = readFileSync(join(CONTENT, `${slug}.md`), 'utf8').replace(/\r\n/g, '\n');
  const { data, body } = splitFrontMatter(source);
  if (data.title === undefined) {
    throw new Error(`content/${slug}.md has no title in its front matter`);
  }
  const rendered = renderer.render(body);
  return {
    slug,
    // The home page is the site's root, every other page a folder of its own.
    path: slug === 'index' ? '' : `${slug}/`,
    title: data.title,
    description: data.description,
    lead: data.lead,
    edit: `${site.editBase}${slug}.md`,
    ...rendered,
  };
});
const bySlug = new Map(pages.map((page) => [page.slug, page]));
const nav = site.nav.map((group) => ({
  section: group.section,
  pages: group.pages.map((slug) => bySlug.get(slug)),
}));

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// The script and the stylesheet. Split, so the search code and its library
// load only when somebody opens the search.
const bundled = await build({
  entryPoints: { site: join(ROOT, 'client', 'main.ts'), style: join(ROOT, 'client', 'site.css') },
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  target: ['es2022'],
  outdir: join(DIST, 'assets'),
  entryNames: '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  assetNames: '[name]-[hash]',
  publicPath: `${site.base}assets/`,
  loader: { '.woff2': 'file' },
  metafile: true,
  logLevel: 'warning',
});
const assets = {};
for (const [file, output] of Object.entries(bundled.metafile.outputs)) {
  const url = `${site.base}${relative(DIST, resolve(file)).replace(/\\/g, '/')}`;
  if (output.entryPoint?.endsWith('main.ts')) {
    assets.js = url;
  } else if (output.entryPoint?.endsWith('site.css')) {
    assets.css = url;
  }
}
if (assets.js === undefined || assets.css === undefined) {
  throw new Error('The bundle has no script or no stylesheet');
}

for (const [index, page] of pages.entries()) {
  const html = renderPage({
    site,
    page,
    nav,
    html: page.html,
    headings: page.headings,
    previous: pages[index - 1] ?? null,
    next: pages[index + 1] ?? null,
    assets,
  });
  const folder = join(DIST, page.path);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'index.html'), html);
}

// What GitHub Pages serves for an address that is not a page.
writeFileSync(
  join(DIST, '404.html'),
  renderPage({
    site,
    page: { slug: '404', title: 'Nothing at this address', lead: 'There is no page here. It may have moved; the search finds what is on the site now.' },
    nav,
    html: `<p><a href="${site.base}">Go to the start of the docs</a>.</p>`,
    headings: [],
    previous: null,
    next: null,
    assets,
  }),
);

// The search index: one entry per section of every page, so a result lands
// on the heading it matched rather than the top of a long page.
const search = new MiniSearch(SEARCH_OPTIONS);
let id = 0;
for (const page of pages) {
  for (const section of page.sections) {
    id += 1;
    search.add({
      id,
      title: page.title,
      heading: section.heading ?? '',
      text: section.text,
      url: `${site.base}${page.path}${section.id === null ? '' : `#${section.id}`}`,
      excerpt: section.text.slice(0, 140),
    });
  }
}
writeFileSync(join(DIST, 'search-index.json'), JSON.stringify(search));

writeFileSync(
  join(DIST, 'favicon.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="#0e7c73" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="#0e7c73"/></svg>\n',
);
// Published from a workflow, the tree is served as it is. Were it ever served
// from a branch instead, Pages would run Jekyll over it, which drops files
// whose names begin with an underscore; this file says not to.
writeFileSync(join(DIST, '.nojekyll'), '');

process.stdout.write(
  `docs: ${pages.length} pages, ${id} search entries, base ${site.base}, in ${Date.now() - started} ms\n`,
);
