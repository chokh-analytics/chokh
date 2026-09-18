# @chokh/server

The collector, the stats API, the realtime stream and the dashboard host, in one
process and one image.

## What is built

| Surface | Ticket |
| --- | --- |
| `GET /health` | AN-REPO01 |
| `POST /api/collect` | AN-COL01 |
| Storage behind the `AnalyticsStore` adapter | AN-STO01 |
| Sessions, visitors, presence, the rollup and retention jobs | AN-SES01 |
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
9. **The identity.** A batch naming a `userId` is believed when its signature
   checks out, or when it carries none and the site accepts an unsigned
   identify. Anything else is refused: the identify events are dropped, the rest
   of the batch is collected anonymously, and a line in the log says so.
10. **The store.** Written through the `AnalyticsStore` interface, which is also
    where the batch becomes sessions and visitors.

An event carries the browser's clock, so `ts` is bounded to the moment the batch
arrived and never backdated by more than a day.

## Identity

A page can call `pa('identify', 'u_someone')` with any id it likes. On a simple
site that is the feature working, so `allowUnsignedIdentify` defaults to `true`.
On a site where an identified person's profile shows their addresses and their
pages to an administrator, a forged identify is one visitor reading another's
history, so that site turns the setting off and signs instead: it keeps an
`identifySecret` on the server, hands the page

```
base64url(hmac_sha256(identifySecret, siteId + "
" + userId))
```

and the tracker passes it back as the fourth argument of `pa('identify')`. The
secret never reaches a browser. A signature that is present and wrong is refused
whatever the setting says: an absent one is a site that never signs, a wrong one
is somebody trying.

Nothing unconfirmed reaches a visitor row, merges an anonymous history or
answers a per-user lookup. The store only ever sees identity the collector has
already confirmed.

## Sessions and visitors

`ingest` is where a batch becomes a stay.

- **A session is a visitor's events with no thirty minute gap**, measured from
  the last sign of life, so a long visit that keeps sending is one session. Its
  id is derived from the site, the visitor and the start instant, so a batch
  that arrives twice lands on one row instead of two.
- **What it records:** the entry and exit path, the pageview and event counts,
  the duration from its first event to its last, the referrer, UTM, location,
  device and address it came in with, and a channel. A leave beacon sets
  `endedAt`.
- **The channel** is `direct`, `organic`, `social`, `referral`, `email`, `paid`
  or `ai`. `utm_medium` decides when the link was tagged, because the person who
  built it knew; otherwise the referrer does, and an assistant (ChatGPT,
  Perplexity, Gemini, Claude, Copilot) is its own channel rather than a search
  engine or a referral. A referrer on your own hostname is not a referral.
- **A visit is a session, counted on the day it began**, and a bounce is a
  session with at most one pageview. A stay that crosses midnight is one visit,
  on the day it started.
- **The visitor row** keeps the counts, the devices, the addresses, where they
  usually connect from and what first and last brought them, so a profile
  survives the raw rows ageing out.
- **The merge:** the first time a confirmed identity reaches a visitor, every
  session and event of theirs takes the name, which is what makes the anonymous
  history theirs. A visitor who already answers to somebody else keeps their old
  stays under the old name: one person does not inherit another's history
  because they shared a computer. `pa('reset')` on logout is the way a browser
  says the person at the keyboard changed.

## Who is here now

Presence is a sorted set per site, scored by the last sign of life. Ingest
writes one entry per live visitor and `realtime()` reads it back; raw events are
never scanned for this.

- **`REDIS_URL` set:** the set lives in Redis, so every process of an install
  counts the same visitors.
- **Unset:** a map in this process, which is a complete install on one
  container and wrong behind a load balancer.

Online means a sign of life within the last minute, and "online for" counts from
the session start. Crawlers are not in the set. Presence is not storage: it is a
minute's window over a half hour set, rebuilt by the next heartbeat, so losing
Redis costs the online count for a minute and nothing else.

## The jobs

Three, all idempotent, all safe to run twice, none holding a lock, so two
processes of one install need no leader between them.

- **The rollup**, hourly. It rolls the site's yesterday, which its own timezone
  decides, and never a day older than `retentionDays - 1`: a day whose raw rows
  have begun to expire would roll up smaller than it was, and the rollup is the
  only copy of that day that outlives the detail. The first pass after a start
  reaches back a week, so a short outage heals itself.
- **The retention purge**, on the same tick. Events, the sessions that ended and
  the visitors last seen before the site's retention. The rollups are never
  touched.
- **The geo refresh**, daily, which downloads only when the installed database
  is over a month old.

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
| `REDIS_URL` | none | Set it and presence lives in Redis, unset and it lives in this process |

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
- **Visitors and pageviews are counted off events; visits, bounces and the
  average stay off sessions.** The three session numbers attribute to every
  dimension a session row carries, which is all of them except `page`, `screen`,
  `lang` and `event`: a visit spans pages rather than being one, so those read 0
  and null. For the same reason, a filter naming one of them leaves the visit
  numbers unanswered.
- **`entry`, `exit` and `channel` are read off sessions**, because no event
  carries them. A filter on one of those three is refused with
  `UNSUPPORTED_FILTER` rather than quietly matching nothing; AN-SEG01 owns the
  segment that resolves it.

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
- **In cookieless mode `pa('reset')` cannot rotate the visitor id either**,
  because nothing is stored to rotate. After a logout on a shared device, the
  next person on that address and browser is attributed to the person who
  logged out, until the daily salt turns. Persistent mode throws the stored id
  away on `reset` and has no such window, so a site where people sign in on
  shared machines should run `persistent`.

## Layering

`routes/` register, `controllers/` validate with Zod and return the envelope,
`services/` hold the logic, `store/` is the only place that knows storage. See
[AGENTS.md](../../AGENTS.md) section 5.
