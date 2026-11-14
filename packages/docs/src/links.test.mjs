import { describe, expect, it } from 'vitest';

import { checkLinks, readPage } from './links.mjs';

const BASE = '/chokh/';

function site(entries) {
  return new Map(entries.map(([url, html]) => [url, readPage(html, url)]));
}

describe('the link check', () => {
  it('passes links that arrive, at a page, a file and an id', () => {
    const pages = site([
      ['/chokh/', '<a href="/chokh/licence/">x</a><a href="/chokh/licence/#keys">y</a><a href="#top">z</a><h1 id="top">t</h1><script src="/chokh/assets/site.js"></script>'],
      ['/chokh/licence/', '<h2 id="keys">Keys</h2><a href="../">home</a>'],
    ]);
    const files = new Set(['/chokh/assets/site.js']);
    expect(checkLinks(pages, files, BASE)).toEqual({ problems: [], external: 0 });
  });

  it('names a page that is not there, an id that is not on it, and a link outside the base', () => {
    const pages = site([
      ['/chokh/', '<a href="/chokh/missing/">a</a><a href="/chokh/#nowhere">b</a><a href="/other/">c</a><a href="">d</a>'],
    ]);
    const { problems } = checkLinks(pages, new Set(), BASE);
    expect(problems).toEqual([
      '/chokh/: /chokh/missing/ is not a page or a file of the site',
      '/chokh/: /chokh/#nowhere names #nowhere, which /chokh/ does not have',
      '/chokh/: /other/ is outside /chokh/',
      '/chokh/: an empty link',
    ]);
  });

  it('counts an address elsewhere and does not fetch it', () => {
    const pages = site([['/chokh/', '<a href="https://github.com/x">a</a><a href="mailto:a@b.example">b</a>']]);
    expect(checkLinks(pages, new Set(), BASE)).toEqual({ problems: [], external: 2 });
  });

  it('refuses a link that leaves by two slashes', () => {
    const pages = site([['/chokh/', '<a href="//evil.example/">a</a>']]);
    expect(checkLinks(pages, new Set(), BASE).problems).toEqual(['/chokh/: //evil.example/ leaves the site without saying so']);
  });
});
