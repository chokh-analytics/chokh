import { createElement as h, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The page around every page of the docs, rendered once at build time. React
// here is a template that escapes what it is given, nothing more: no React is
// sent to a browser, and the little that runs there is client/main.ts.

// Applied before the first paint, so a reader who chose dark never sees a
// flash of light. Also marks that scripts run, so the buttons that need them
// are shown only when they will work. Wrapped, because a browser that refuses
// storage still has to get a page.
const THEME_SCRIPT =
  "(function(){var d=document.documentElement;d.classList.add('js');try{var t=localStorage.getItem('chokh:theme');if(t==='light'||t==='dark'){d.dataset.theme=t;}}catch(e){}})();";

function Icon({ path, size = 20 }) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d: path, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  );
}

const ICONS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm9 3l-4.35-4.35',
  // A circle half filled: whatever the system says.
  system: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 0v18',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z',
};

// The mark: an eye, which is what the name means.
function Mark() {
  return h(
    'svg',
    { width: 24, height: 24, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', className: 'mark' },
    h('path', { d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
    h('circle', { cx: 12, cy: 12, r: 3.2, fill: 'currentColor' }),
  );
}

function NavList({ nav, current, base }) {
  return nav.map((group) =>
    h(
      'div',
      { className: 'nav-group', key: group.section },
      h('p', { className: 'nav-heading' }, group.section),
      h(
        'ul',
        null,
        group.pages.map((page) =>
          h(
            'li',
            { key: page.slug },
            h(
              'a',
              {
                href: `${base}${page.path}`,
                ...(page.slug === current ? { 'aria-current': 'page' } : {}),
              },
              page.menu ?? page.title,
            ),
          ),
        ),
      ),
    ),
  );
}

function Toc({ headings }) {
  if (headings.length < 2) {
    return null;
  }
  return h(
    'aside',
    { className: 'toc', 'aria-labelledby': 'toc-heading' },
    h('p', { className: 'toc-heading', id: 'toc-heading' }, 'On this page'),
    h(
      'ul',
      null,
      headings.map((heading) =>
        h('li', { key: heading.id, className: heading.level === 3 ? 'toc-sub' : undefined }, h('a', { href: `#${heading.id}` }, heading.text)),
      ),
    ),
  );
}

function Pager({ previous, next, base }) {
  if (previous === null && next === null) {
    return null;
  }
  return h(
    'nav',
    { className: 'pager', 'aria-label': 'Previous and next page' },
    previous === null
      ? h('span')
      : h('a', { href: `${base}${previous.path}`, rel: 'prev' }, h('span', { className: 'pager-dir' }, 'Previous'), h('span', null, previous.title)),
    next === null
      ? h('span')
      : h('a', { href: `${base}${next.path}`, rel: 'next', className: 'pager-next' }, h('span', { className: 'pager-dir' }, 'Next'), h('span', null, next.title)),
  );
}

// One page, as a complete HTML document.
export function renderPage({ site, page, nav, html, headings, previous, next, assets }) {
  const base = site.base;
  const title = page.slug === 'index' ? site.title : `${page.title} | ${site.title}`;
  const description = page.description ?? site.description;
  const document = h(
    'html',
    { lang: 'en' },
    h(
      'head',
      null,
      h('meta', { charSet: 'utf-8' }),
      h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('title', null, title),
      h('meta', { name: 'description', content: description }),
      h('meta', { name: 'color-scheme', content: 'light dark' }),
      h('meta', { name: 'theme-color', content: '#f6f7f4', media: '(prefers-color-scheme: light)' }),
      h('meta', { name: 'theme-color', content: '#0e1417', media: '(prefers-color-scheme: dark)' }),
      h('meta', { property: 'og:title', content: title }),
      h('meta', { property: 'og:description', content: description }),
      h('link', { rel: 'icon', href: `${base}favicon.svg`, type: 'image/svg+xml' }),
      h('script', { dangerouslySetInnerHTML: { __html: THEME_SCRIPT } }),
      h('link', { rel: 'stylesheet', href: assets.css }),
      h('script', { type: 'module', src: assets.js }),
    ),
    h(
      'body',
      { 'data-base': base },
      h('a', { className: 'skip', href: '#content' }, 'Skip to the content'),
      h(
        'header',
        { className: 'top' },
        h(
          'button',
          { type: 'button', className: 'icon-button needs-js menu-button', 'aria-controls': 'drawer', 'aria-haspopup': 'dialog', 'aria-label': 'Open the menu' },
          h(Icon, { path: ICONS.menu }),
        ),
        h('a', { className: 'brand', href: base }, h(Mark), h('span', null, site.name), h('span', { className: 'brand-docs' }, 'docs')),
        h('div', { className: 'top-gap' }),
        h(
          'button',
          // Named in full, because on a phone only the magnifier shows.
          { type: 'button', className: 'search-button needs-js', 'aria-haspopup': 'dialog', 'aria-controls': 'search', 'aria-label': 'Search the docs', 'aria-keyshortcuts': '/' },
          h(Icon, { path: ICONS.search, size: 18 }),
          h('span', { className: 'search-label' }, 'Search'),
          h('kbd', null, '/'),
        ),
        h('a', { className: 'top-link', href: site.repository }, 'GitHub'),
        h(
          'button',
          { type: 'button', className: 'icon-button needs-js theme-button', 'aria-label': "Colour theme: the system's setting. Switch to light" },
          h('span', { className: 'theme-icon', 'data-for': 'system' }, h(Icon, { path: ICONS.system })),
          h('span', { className: 'theme-icon', 'data-for': 'light' }, h(Icon, { path: ICONS.sun })),
          h('span', { className: 'theme-icon', 'data-for': 'dark' }, h(Icon, { path: ICONS.moon })),
        ),
      ),
      h(
        'div',
        { className: 'layout' },
        h('nav', { className: 'sidebar', 'aria-label': 'Docs' }, h(NavList, { nav, current: page.slug, base })),
        h(
          'main',
          { id: 'content', tabIndex: -1 },
          h(
            'article',
            { className: 'prose' },
            h('h1', null, page.title),
            page.lead === undefined ? null : h('p', { className: 'lead' }, page.lead),
            h('div', { dangerouslySetInnerHTML: { __html: html } }),
          ),
          h(Pager, { previous, next, base }),
          page.edit === undefined
            ? null
            : h('p', { className: 'edit' }, h('a', { href: page.edit }, 'Edit this page on GitHub')),
        ),
        h(Toc, { headings }),
      ),
      h(
        'footer',
        { className: 'foot' },
        h(
          'p',
          null,
          'Chokh is MIT licensed, except ',
          h('code', null, 'packages/ee'),
          ', which is under a commercial licence. ',
          h('a', { href: `${base}licence/` }, 'What that means'),
          '. ',
          h('a', { href: site.repository }, 'The source is on GitHub'),
          '.',
        ),
      ),
      h(
        'dialog',
        { id: 'drawer', className: 'drawer', 'aria-label': 'Menu' },
        h(
          'div',
          { className: 'drawer-head' },
          h('a', { className: 'brand', href: base }, h(Mark), h('span', null, site.name), h('span', { className: 'brand-docs' }, 'docs')),
          h('button', { type: 'button', className: 'icon-button drawer-close', 'aria-label': 'Close the menu' }, h(Icon, { path: ICONS.close })),
        ),
        h('nav', { 'aria-label': 'Docs, in the menu' }, h(NavList, { nav, current: page.slug, base })),
        h('p', { className: 'drawer-foot' }, h('a', { href: site.repository }, 'Chokh on GitHub')),
      ),
      h(
        'dialog',
        { id: 'search', className: 'search', 'aria-labelledby': 'search-title' },
        h(
          'form',
          { method: 'dialog', className: 'search-form', role: 'search' },
          h('h2', { id: 'search-title', className: 'visually-hidden' }, 'Search the docs'),
          h('label', { htmlFor: 'search-input', className: 'visually-hidden' }, 'Search the docs'),
          h(Icon, { path: ICONS.search, size: 18 }),
          h('input', { id: 'search-input', type: 'search', autoComplete: 'off', spellCheck: 'false', placeholder: 'Search the docs', 'aria-controls': 'search-results', 'aria-describedby': 'search-status' }),
          h('button', { type: 'submit', className: 'search-close', value: 'close' }, 'Close'),
        ),
        h('p', { id: 'search-status', className: 'search-status', role: 'status' }),
        h('ul', { id: 'search-results', className: 'search-results' }),
      ),
    ),
  );
  return `<!doctype html>\n${renderToStaticMarkup(h(Fragment, null, document))}\n`;
}
