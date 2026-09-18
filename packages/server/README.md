# @chokh/server

The collector, the stats API, the realtime stream and the dashboard host, in one
process and one image.

## What is built

| Surface | Ticket |
| --- | --- |
| `GET /health` | AN-REPO01 |
| `POST /api/collect` | AN-COL01 |
| Storage behind the `AnalyticsStore` adapter | AN-STO01 |
| The stats API, the SSE stream, keys and SSO | AN-API01 |

## POST /api/collect

Takes one batch from the tracker and answers `202` with no body, because a
beacon cannot read a response. Every failure answers with the envelope.

The body is read as JSON whatever the content type says: the tracker posts under
`text/plain` so a beacon never preflights on a cross-origin post.

What happens to a batch, in order:

1. **Rate limits.** Per address, then per site, both a fixed window of a minute.
   Over the limit answers `429 RATE_LIMITED`.
2. **The site.** Resolved from `siteId` through the store. No site answers to
   that key gives `403 UNKNOWN_SITE`.
3. **The origin.** The `Origin` header, or the `Referer` when a browser sent only
   that, has to be one of the site's domains. Anything else gives
   `403 ORIGIN_NOT_ALLOWED`.
4. **The visitor.** A site in `persistent` mode keeps the id the tracker sent. A
   cookieless site gets a salted hash of the address, the user agent and the
   site, with the salt rotated daily, so the id cannot outlive the day or be
   walked back to a person.
5. **The bot filter.** A maintained user agent list, headless and HTTP client
   markers, and a per-visitor event rate. It **tags**, never drops, so a
   dashboard can show the bot share.
6. **Enrichment.** Location from the geo database, and browser, OS and device
   from the user agent, with Client Hints preferred wherever they are sent.
7. **The site's IP mode**, applied before anything is stored.
8. **Dedupe.** A pageview repeated for the same visitor and path within two
   seconds is one pageview.
9. **The store.** Written through the `AnalyticsStore` interface. AN-STO01 lands
   the MongoDB adapter; until then a fresh install runs on the in-memory one and
   keeps nothing across a restart.

An event carries the browser's clock, so `ts` is bounded to the moment the batch
arrived and never backdated by more than a day.

## The geo database

Location comes from a MaxMind style database read from `GEOIP_DIR`, opened once
and queried in place. A refresh job checks daily and downloads a new one when
the installed database is older than a month:

- **`GEOIP_LICENSE_KEY` set:** GeoLite2-City from MaxMind.
- **Unset:** DB-IP Lite City, which needs no account, so a keyless install still
  knows where its visitors are.

Neither database is committed: DB-IP Lite City is about 60 MB compressed, which
is past what a repository should carry. Until one is installed, lookups answer
empty and events are still collected.

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `4100` | Where the server listens |
| `LOG_LEVEL` | `info` | pino level |
| `DASHBOARD_DIR` | the sibling package's `dist` | The built dashboard to serve |
| `TRUST_PROXY` | none | Comma separated CIDRs allowed to say who a visitor is |
| `REAL_IP_HEADER` | `X-Forwarded-For` | Or `CF-Connecting-IP`, honoured only from a trusted peer |
| `GEOIP_DIR` | `./data/geo` | Where the geo database lives |
| `GEOIP_LICENSE_KEY` | none | Chooses GeoLite2-City over the keyless fallback |
| `COLLECT_RATE_LIMIT_IP` | `3000` | Batches a minute from one address |
| `COLLECT_RATE_LIMIT_SITE` | `60000` | Batches a minute for one site |
| `MONGODB_URI` | none | Set it and the server runs on MongoDB, unset and it runs on memory |
| `REDIS_URL` | none | Read by presence and the live feed (AN-SES01) |

Behind Cloudflare, set `TRUST_PROXY` to Cloudflare's ranges and `REAL_IP_HEADER`
to `CF-Connecting-IP`, or every visitor's address is Cloudflare's. If your proxy
already resolves the Cloudflare hop and hands on `X-Forwarded-For`, leave
`REAL_IP_HEADER` alone and set `TRUST_PROXY` to that proxy.

One address is not one person. A university lab, an office or a mobile carrier
puts thousands of visitors behind one NAT address, and a single open tab posts a
batch on every heartbeat, three a minute. `COLLECT_RATE_LIMIT_IP` therefore
defaults high enough to hold about a thousand open tabs on one address; a campus
would otherwise lose every batch past the limit to a `429`. Lower it only for a
site whose visitors are known to arrive one address each.

## Storage

The server talks to one interface, `AnalyticsStore`, and never to a database
driver. Which adapter it opens is decided once at boot:

- **`MONGODB_URI` set:** `@chokh/store-mongo`. The database name comes from the
  connection string.
- **`MONGODB_URI` unset:** the in-memory adapter. It answers every read, so the
  tracker and the dashboard work on a laptop with nothing installed, and it
  keeps nothing across a restart. It is not a deployment.

Both adapters pass the same conformance suite in `@chokh/store`.

### Create the indexes before you collect anything

Chokh never builds an index while it is running, because a process that boots
should not start an index build on a live collection. One command owns them:

```
node packages/store-mongo/dist/migrate.js --apply
node packages/store-mongo/dist/migrate.js --verify-only
```

`--apply` creates anything missing. `--verify-only` changes nothing and exits
`1` unless it can report `missing: 0`, so a deployment can gate on it. An index
that Chokh did not declare is reported and never dropped.

### Retention

Each event carries an `expiresAt` stamped from the site's `retentionDays`, and
one TTL index honours it, so one collection can hold sites with different
retentions. `purge(siteId, before)` is the explicit path for a retention change
or for erasing one person's history. Daily rollups are kept forever, so history
survives the purge; only the per-visitor detail ages out.

### What a number means

- **Days are the site's own.** Every day boundary, every rollup key and every
  day, week or month bucket is drawn in the site's `timezone`. A site in Dhaka
  asking "how many came today" gets its own midnight, not UTC's. Weeks start on
  Monday.
- **Today comes from raw events, history from the daily rollups.** A past day
  nobody rolled up contributes nothing; `rollupDay` is idempotent, so a
  backfill is the cure.
- **Visitors over several days is the sum of each day's uniques.** A daily
  rollup cannot hold anything else, so somebody who came on Monday and again on
  Tuesday counts twice in a Monday to Tuesday total. Within one day it is an
  exact count.
- **A filter reads raw events.** A rollup holds one dimension at a time and not
  the cube, so any filter except a bot filter falls back to raw rows. Raw
  retention is therefore how far back a filtered report can see.
- **Bots are out unless you ask for them.** A `bot` filter is how a dashboard
  asks for the crawler share.
- **Hourly series are capped at 7 days**, because rollups are daily and an
  hourly series has to read raw rows for the whole range.
- **Visits, bounce rate and average duration are zero and null for now**, along
  with the `entry`, `exit` and `channel` dimensions. They are facts about a
  session, and AN-SES01 writes sessions.

## Things to know before you point a site at this

- **The origin check is by exact hostname.** `example.com` and `www.example.com`
  are two entries. A subdomain is not covered by its parent.
- **A page served with `Referrer-Policy: no-referrer` sends `Origin: null` on a
  cross-origin beacon, and no `Referer` at all**, so there is nothing to check it
  by and the batch is refused. Serve the tracker and the collect path through a
  first-party proxy path on your own domain (`data-api="/_pa"`), which is worth
  doing anyway because filter lists do not carry it.
- **In cookieless mode one address plus one user agent string is one visitor.**
  A computer lab of identical browsers behind one address counts as a single
  visitor, and its events add up against the 240-events-a-minute bot heuristic,
  which can tag the whole lab as a bot. Persistent mode has neither problem,
  because each browser keeps its own id.

## Layering

`routes/` register, `controllers/` validate with Zod and return the envelope,
`services/` hold the logic, `store/` is the only place that knows storage. See
[AGENTS.md](../../AGENTS.md) section 5.
