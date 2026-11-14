import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Every link in the built site that points inside it has to arrive: at a page
// that exists, and at an id on that page when it names one. Addresses
// elsewhere are counted and not fetched, because a build that depends on
// somebody else's server being up is a build that fails for no reason of
// ours.

const ATTRIBUTE = /\s(href|src)="([^"]*)"/g;
const ID = /\sid="([^"]*)"/g;

function decode(text) {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// What one built page holds: its address, its ids and where it points.
export function readPage(html, url) {
  const ids = new Set();
  for (const match of html.matchAll(ID)) {
    ids.add(decode(match[1]));
  }
  const links = [];
  for (const match of html.matchAll(ATTRIBUTE)) {
    links.push(decode(match[2]));
  }
  return { url, ids, links };
}

// Every HTML file under a folder, as the address it is served at.
export function readSite(dist, base) {
  const pages = new Map();
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.html')) {
        const inside = relative(dist, path).replace(/\\/g, '/');
        const url = `${base}${inside.replace(/(^|\/)index\.html$/, '$1')}`;
        pages.set(url, readPage(readFileSync(path, 'utf8'), url));
      }
    }
  };
  walk(dist);
  return pages;
}

// The problems, one line each, and how many addresses elsewhere were seen.
// `files` is the set of every file's address, so a link to a script, a
// stylesheet or the search index counts as arriving.
export function checkLinks(pages, files, base) {
  const problems = [];
  let external = 0;
  for (const page of pages.values()) {
    for (const link of page.links) {
      if (/^(https?:|mailto:)/.test(link)) {
        external += 1;
        continue;
      }
      if (link === '') {
        problems.push(`${page.url}: an empty link`);
        continue;
      }
      const target = new URL(link, `http://site${page.url}`);
      if (target.host !== 'site') {
        problems.push(`${page.url}: ${link} leaves the site without saying so`);
        continue;
      }
      const path = target.pathname;
      if (!path.startsWith(base)) {
        problems.push(`${page.url}: ${link} is outside ${base}`);
        continue;
      }
      const landing = pages.get(path) ?? null;
      if (landing === null && !files.has(path)) {
        problems.push(`${page.url}: ${link} is not a page or a file of the site`);
        continue;
      }
      const anchor = decodeURIComponent(target.hash.slice(1));
      if (anchor !== '' && (landing === null || !landing.ids.has(anchor))) {
        problems.push(`${page.url}: ${link} names #${anchor}, which ${path} does not have`);
      }
    }
  }
  return { problems, external };
}

// Every file's address, for checkLinks.
export function readFiles(dist, base) {
  const files = new Set();
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        files.add(`${base}${relative(dist, path).replace(/\\/g, '/')}`);
      }
    }
  };
  walk(dist);
  return files;
}
