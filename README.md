# Chokh

**Status: pre-release.** Nothing here is stable yet. The engine is being built
ticket by ticket; see [AGENTS.md](AGENTS.md) for how the work is run.

Chokh (চোখ, "eye") is open source, first-party web analytics you host
yourself. One process carries the whole product: a tracker script under 3 KB,
a collector, a stats API, a realtime stream and a dashboard.

## What it gives you

- Visitors, visits, pageviews, bounce and visit duration, with compare
- Pages, entry and exit pages, time on page and scroll depth
- Referrers, channels (including AI assistants) and UTM campaigns
- Country, region and city from an offline IP database, plus browser, OS and device
- Who is on the site right now, which page they are on and how long they have been there
- Custom events, `identify` for signed-in people, and per-person history
- Privacy as configuration: cookieless or persistent visitor ids, full, anonymised or
  no IP storage, bot filtering, per-site retention
- A JSON API for all of it, with a CSV export and a live stream of who is here
- Accounts, teams and API keys, and a scope of its own for reading addresses and
  identified people, with an audit row for every such read
- Single sign-on, so a staff member clicks through from your own admin panel and
  is already signed in

## The dashboard

![The Chokh overview, light](docs/images/dashboard-overview-light.png)

Six numbers, one chart, four cards, and nothing else on the first screen. Every
number carries a comparison, because a number on its own is not something
anybody can act on. Clicking any row filters the whole page rather than opening
another one: click a country and the pages, the sources and the devices become
that country's.

The five rules it is designed around:

1. The first screen answers the question. Everything else is a report somebody
   asked for.
2. Every number carries a comparison.
3. One accent colour. Green and red mean good and bad, never "this series" and
   "that series".
4. Any row can be clicked to filter, and a row that cannot be filtered is not
   dressed up as one that can.
5. Nothing pretends. A read that failed says so instead of drawing a zero, a
   number nobody measured says "not available" instead of 0, and a page nobody
   has closed yet has no time on page rather than a time of nought.

**Realtime** is the report that says who, and not only how many.

![Who is on the site right now, dark](docs/images/dashboard-realtime-dark.png)

Online first, then everybody seen in the last half hour in a muted tone,
because a page that empties at three in the morning reads as broken. The map
places a dot per city from coordinates that were rounded to two decimals, about
a kilometre, when the presence entry was written: what is kept is where a city
is, and it was never anything finer. An address is a different matter and
appears only for an account with `read:identity`, which is said on screen along
with the fact that the read was logged.

**Geography** paints five bands on a log scale.

![Visitors by country](docs/images/dashboard-geo-light.png)

A continuous ramp looks more precise and reads worse: nobody can tell 1,400
from 1,700 by shade, and on analytics data a linear scale paints the world in
the lightest band with one country in the darkest. The outlines are projected
once at build time and shipped as path strings, so no browser downloads a
mapping library to draw a file that never changes.

**It comes with the server.** There is no second process, no separate host and
no CDN: `docker compose up` serves the dashboard and the collector on one
origin, which is also why the session cookie works and why nothing here is a
cross-origin request.

### What it costs to load

Measured on 2026-09-20 with `pnpm size:dashboard`, which reads the build
manifest and gzips each file:

| | gzipped |
| --- | --- |
| Application | 73.8 KB |
| Libraries (React, the router, the query cache) | 84.6 KB |
| Stylesheet | 7.3 KB |
| Fonts (IBM Plex Sans and Mono, latin, woff2) | 59.0 KB |

The fonts are counted because they are served from the install: a dashboard
that fetches a font from somebody else's CDN tells that CDN who is reading it,
which is the thing this product exists not to do. The budgets are per file and
CI fails a build that exceeds one.

### Accessibility

Lighthouse scores it 1 on the Overview and on Realtime, in both the light and
the dark palette, over 25 and 28 applicable audits respectively. CI fails under
1, and the run also asserts that the page it audited had the dashboard rendered
in it, because Lighthouse scores a blank page 1. Every chart carries its numbers
as a table for a screen reader, including the world map.

### Keyboard

`g` then a letter for a report, `t` `y` `7` `3` for the ranges, `[` and `]` to
step the window, `c` for the comparison, `x` to clear the filters, `l` for the
palette. `?` lists them all. Nothing fires while you are typing, and nothing
takes a key the browser already uses.

### Pictures and audits

```bash
pnpm --filter @chokh/dashboard build
pnpm --filter @chokh/dashboard run shots   # fourteen screenshots, seven reports in two themes
pnpm --filter @chokh/dashboard run a11y    # the audit above, as JSON
pnpm --filter @chokh/dashboard run test:e2e
```

Each starts its own fixture install, so none of them needs a database, and the
clock is frozen for the screenshots so the same command produces the same
pictures.

## One-line install

```bash
git clone https://github.com/chokh-analytics/chokh.git && cd chokh && docker compose up
```

The dashboard and the collector are then on `http://localhost:4100`, with
MongoDB and Redis beside them. Register the first account, which owns the install,
and create a site:

```bash
curl -c jar -X POST localhost:4100/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password"}'

curl -b jar -X POST localhost:4100/api/sites \
  -H 'content-type: application/json' \
  -d '{"id":"my_site","name":"My site","domains":["example.com"]}'
```

Then drop the script into any page you want counted:

```html
<script defer data-site="my_site" src="https://analytics.example.com/a.js"></script>
```

The API, its scopes and its SSO exchange are documented in
[packages/server/README.md](packages/server/README.md).

## The published image

Every green CI run on `main` publishes one image, `ghcr.io/chokh-analytics/chokh`,
tagged `sha-<commit>` and `latest`. A deployment pins the digest that run prints
rather than a tag, because a tag is a pointer somebody can move and a digest is
the image itself.

## Layout

| Package | What it is |
| --- | --- |
| `packages/tracker` | The browser script, no dependencies, at most 3 KB gzipped |
| `packages/server` | Collector, stats API, realtime stream, dashboard hosting |
| `packages/dashboard` | The dashboard UI, built static and served by the server |
| `packages/store` | The `AnalyticsStore` contract and the conformance suite every adapter passes |
| `packages/store-mongo` | The MongoDB storage adapter |
| `packages/geo` | IP to location and user agent parsing, offline |
| `packages/sdk-node` | Server-side `track` and `identify`, and the identify signature |

Storage sits behind one `AnalyticsStore` interface, so an adapter can be
swapped without touching a report.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Requires Node 22 and pnpm 10.

## License

MIT. Copyright (c) 2026 BWJ Tech Ltd. See [LICENSE](LICENSE).

Progsity (progsity.io) is its first user.
