// What the docs site is: its name, where it is served, and the order of its
// pages. The build refuses a page that is not in the navigation and an entry
// in the navigation that has no page, so the two cannot drift apart.

// Where the site is served from, ending in a slash. GitHub Pages serves a
// project's site under the repository's name, so the default is that; a
// domain of its own later is this one setting (DOCS_BASE=/).
const base = process.env.DOCS_BASE ?? '/chokh/';
if (!base.startsWith('/') || !base.endsWith('/')) {
  throw new Error(`DOCS_BASE has to start and end with a slash, and is ${JSON.stringify(base)}`);
}

export const site = {
  name: 'Chokh',
  title: 'Chokh documentation',
  description:
    'Chokh is open source, first-party web analytics you host yourself: a tracker under 3 KB, a collector, a stats API and a dashboard in one process.',
  base,
  repository: 'https://github.com/chokh-analytics/chokh',
  // Where "Edit this page" points: the page's own file on the default branch.
  editBase: 'https://github.com/chokh-analytics/chokh/edit/main/packages/docs/content/',
  // The navigation, in order. A slug is the page's file name under content/
  // without `.md`, and `index` is the home page.
  nav: [
    { section: 'Start here', pages: ['index', 'quickstart'] },
    { section: 'Guides', pages: ['nextjs', 'server-events', 'first-party'] },
    { section: 'Running it', pages: ['self-hosting', 'environment'] },
    { section: 'Reference', pages: ['api'] },
    { section: 'The project', pages: ['licence'] },
  ],
};
