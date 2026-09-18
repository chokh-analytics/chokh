# @chokh/server

The collector, the stats API, the realtime stream and the dashboard host, in one
process and one image.

## What is built

| Surface | Ticket |
| --- | --- |
| `GET /health` | AN-REPO01 |
| `POST /api/collect` | AN-COL01 |
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
| `COLLECT_RATE_LIMIT_IP` | `600` | Batches a minute from one address |
| `COLLECT_RATE_LIMIT_SITE` | `60000` | Batches a minute for one site |
| `MONGODB_URI`, `REDIS_URL` | none | Read by AN-STO01 and AN-SES01 |

Behind Cloudflare, set `TRUST_PROXY` to Cloudflare's ranges and `REAL_IP_HEADER`
to `CF-Connecting-IP`, or every visitor's address is Cloudflare's.

## Layering

`routes/` register, `controllers/` validate with Zod and return the envelope,
`services/` hold the logic, `store/` is the only place that knows storage. See
[AGENTS.md](../../AGENTS.md) section 5.
