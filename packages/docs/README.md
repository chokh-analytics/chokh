# @chokh/docs

The Chokh documentation site. Private: never published to npm. It is built
static, from Markdown, by a script of its own (`scripts/build.mjs`) rather than
a docs framework, so it adds about 5.5 MB to an install and builds in well under
a second.

## Commands

```bash
pnpm --filter @chokh/docs site          # build into dist/, served under /chokh/
pnpm --filter @chokh/docs site:serve    # serve dist/ on http://127.0.0.1:4120/chokh/
pnpm --filter @chokh/docs site:links    # every link inside the site arrives
pnpm --filter @chokh/docs site:a11y     # Lighthouse accessibility, every page, phone and desktop, both themes
pnpm --filter @chokh/docs test          # the generator's own cases
```

`DOCS_BASE=/` builds it for a domain of its own instead of
`https://chokh-analytics.github.io/chokh/`.

## Writing a page

A page is a file in `content/`, named in the navigation in `site.config.mjs`;
the build refuses a page that is in no menu and a menu entry with no page. It
starts with front matter:

```markdown
---
title: Licence
lead: One sentence under the title.
description: What a search engine shows.
---
```

The title is the page's only `h1`, so the Markdown starts at `##`. A link to
another page is written from the site's root, `[Licence](/licence/)`, and the
build puts the base path in front of it.

Code blocks in a row, each with a label after its language, are one set of
tabs, and a reader's choice is remembered across pages:

````markdown
```bash PostgreSQL
docker compose up
```

```bash MongoDB
docker compose -f docker-compose.mongodb.yml up -d
```
````

## How it is made

| Where | What |
| --- | --- |
| `src/markdown.mjs` | Markdown to HTML: ids on headings, base paths on links, tabs, code coloured by Prism at build time |
| `src/page.mjs` | The page around every page, rendered once by `react-dom/server`; no React reaches a browser |
| `client/main.ts` | What runs in a browser: the theme switch, the menu, copy buttons, tabs, opening the search |
| `client/search.ts` | The search, loaded the first time it opens, over an index built with the site |
| `client/site.css` | The dashboard's own tokens (`packages/dashboard/src/theme/tokens.css`) and fonts, so the docs and the product look like one thing |

Every page works without its script: the theme follows the system, each tab's
code is shown under its label, and the navigation is a list of links.

The site is published by `.github/workflows/docs.yml`, once GitHub Pages is
switched on for the repository and the variable `DOCS_PAGES` is `on`.
