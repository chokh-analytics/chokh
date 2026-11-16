# @chokh/docs

The Chokh documentation site. Private: never published to npm. It is built
static, from Markdown, by a script of its own (`scripts/build.mjs`) rather than
a docs framework, so it adds about 5.5 MB to an install and builds in well under
a second.

## Commands

```bash
pnpm --filter @chokh/docs site          # build into dist/, served at the root
pnpm --filter @chokh/docs site:serve    # serve dist/ on http://127.0.0.1:4120/
pnpm --filter @chokh/docs site:links    # every link inside the site arrives
pnpm --filter @chokh/docs site:a11y     # Lighthouse accessibility, every page, phone and desktop, both themes
pnpm --filter @chokh/docs test          # the generator's own cases
pnpm --filter @chokh/docs site:examples # compile every code sample against the packages
pnpm --filter @chokh/docs site:generate # rewrite the pages that come from the code (--check to compare)
```

The site is built for its own domain, `https://chokh.dev/`. `DOCS_BASE=/chokh/`
builds it for a folder instead, as GitHub Pages serves a project without a
domain (`https://chokh-analytics.github.io/chokh/`).

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

A code sample that is code (TypeScript, JavaScript) is a file under
`examples/`, named on the block, so CI compiles it against the packages
(`site:examples`) and a renamed option fails there instead of in front of a
reader:

````markdown
```tsx React file=react/root.tsx
```
````

Pages that come from the code are written by `scripts/generate.mjs` into
`generated/` and committed; `site:generate --check` in CI fails when one is
not what the code says. Today that is the environment page, from
`packages/server/src/config/env.docs.json` and `packages/ee/src/env.docs.json`.

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

## The demo

`/demo/` is the dashboard itself, built by `site:demo` from
`packages/dashboard/vite.demo.config.ts`, over the frozen fixture the README's
pictures are taken from (`packages/dashboard/e2e/fixture-data.mjs`). There is
no server: every request it makes to `/api` is answered in the page from the
same answers the fixture server gives (`e2e/fixture-answers.mjs`), and a
change is refused. The business it shows is invented and named in one place,
`packages/dashboard/e2e/demo-site.mjs`. `site:demo-check` opens it in
Chromium, Firefox and WebKit, with storage and without.

```bash
pnpm --filter @chokh/docs site:demo        # build the demo for the docs' address
pnpm --filter @chokh/docs site:demo-check  # open it in every browser installed
```

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
