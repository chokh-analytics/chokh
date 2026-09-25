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

## A first-party proxy

Serving the tracker and the collect path from your own domain (`data-api="/_pa"`)
is worth doing: filter lists do not carry a first-party path, and a page with
`Referrer-Policy: no-referrer` has no `Origin` to check on a cross-origin beacon.
It costs you one thing. Your proxy is now the peer this collector sees, so
without the header pair below every visitor of your site is stored as the proxy:
one address, one country, and in cookieless mode one visitor id for everybody.

`TRUST_PROXY` is not the answer. Your proxy is often somebody else's
infrastructure with an address range that changes without notice, and the hop in
front of it is trusted already. So the proxy carries the address across and
signs it, because a header anybody can set is an address anybody can claim:

```
X-Chokh-Forwarded-For: 103.87.12.45
X-Chokh-Forwarded-Sig: 1758268800000.<base64url signature>
```

The signature is the second half of the `Sig` value, and the instant it was made
is the first, so the collector knows which one to check:

```
base64url(hmac_sha256(CHOKH_PROXY_SECRET, address + "\n" + ts))
```

`ts` is the Unix time in **milliseconds**, written in decimal with no leading
zero, and the same number appears in front of the dot. The collector believes a
`ts` within 120 seconds of the moment the request arrived, either side, so a
proxy whose clock drifts a little still works and a header read out of a log is
worth nothing two minutes later.

In Node that is one line from `@chokh/sdk-node`:

```js
import { signForwardedAddress } from '@chokh/sdk-node';

const ts = Date.now();
headers.set('X-Chokh-Forwarded-For', ip);
headers.set('X-Chokh-Forwarded-Sig', `${ts}.${signForwardedAddress(secret, ip, ts)}`);
```

Four things to know:

- **Nothing here is ever a refusal.** A missing, forged, stale or unreadable
  signature falls back to the peer chain and the batch is still collected. A
  beacon cannot read a refusal, so a mistake in your proxy costs you the
  addresses and not the traffic.
- **`CHOKH_PROXY_SECRET` is server side, always.** A browser that could read it
  could claim any address. It is not a `NEXT_PUBLIC_` or `VITE_` variable.
- **Forward the browser's headers too.** The user agent, the `sec-ch-ua*` Client
  Hints and the `Origin` are read from the request as they always were, so a
  proxy that sends its own runtime's user agent gets a site full of that.
- **The tracker file does not need any of this.** `a.js` is a static file, so a
  plain rewrite is right for it. Only the collect path goes through the proxy
  that signs.

## The stats API

Every route answers the envelope: `{ success: true, data, meta? }` or
`{ success: false, error: { code, message, details? } }`. That includes `401` and
`403`, so a client parses the unhappy path the same way it parses the happy one.
Two deliberate shapes are not JSON objects: `export.csv` answers a file, and the
realtime stream answers `text/event-stream` frames whose `data:` line is the
success envelope. A failure on either is the ordinary envelope.

| Route | Needs | Notes |
| --- | --- | --- |
| `POST /api/collect` | nothing | Site key and origin check. See above. |
| `POST /api/auth/register` | nothing, then `admin` | Open only while there is no account |
| `POST /api/auth/login` | nothing | Sets the session cookie |
| `POST /api/auth/logout` | a session | Clears it |
| `GET /api/me` | a session or a key | Who you are, your teams, and your sites with your scopes |
| `POST /api/sso`, `GET /api/sso` | nothing | A five minute token becomes a session |
| `GET /api/sites` | a session | The sites you may read |
| `POST /api/sites` | owner of the team | At least one domain; the zone goes in `settings.timezone`. Returns `identifySecret` once |
| `GET /api/sites/:siteId` | `read:stats` | Never carries `identifySecret` |
| `PATCH /api/sites/:siteId` | `admin` | Settings merged field by field |
| `POST /api/sites/:siteId/identify-secret/rotate` | `admin` | Returns the new secret once |
| `GET`/`POST /api/sites/:siteId/keys` | `admin` | The token is shown once |
| `DELETE /api/sites/:siteId/keys/:keyId` | `admin` | Takes effect immediately |
| `PUT /api/teams/:teamId/members/:userId` | owner of the team | Role and identity flag |
| `GET /api/sites/:siteId/stats/aggregate` | `read:stats` | Totals for a range |
| `GET /api/sites/:siteId/stats/timeseries` | `read:stats` | `interval=minute\|hour\|day\|week\|month` |
| `GET /api/sites/:siteId/stats/breakdown` | `read:stats` | `dim=page\|referrer\|country\|…` |
| `GET /api/sites/:siteId/stats/engagement` | `read:stats` | Time on page and scroll depth, raw rows only |
| `GET /api/sites/:siteId/stats/events` | `read:stats` | Custom events by name, raw rows only |
| `GET /api/sites/:siteId/stats/properties` | `read:stats` | One event by one property, `event=` required |
| `GET /api/sites/:siteId/stats/goals` | `read:stats` | Every goal's conversion at once |
| `GET /api/sites/:siteId/goals` | `read:stats` | The site's goals, oldest first |
| `POST /api/sites/:siteId/goals` | `admin` | Add a goal |
| `DELETE /api/sites/:siteId/goals/:goalId` | `admin` | Delete one; nothing counted is lost |
| `GET /api/sites/:siteId/funnels` | `read:stats` | The site's funnels, oldest first |
| `POST /api/sites/:siteId/funnels` | `admin` | Add a funnel |
| `DELETE /api/sites/:siteId/funnels/:funnelId` | `admin` | Delete one; nothing counted is lost |
| `GET /api/sites/:siteId/stats/funnel` | `read:stats` | How far people got through one funnel, `funnel=` required |
| `GET /api/sites/:siteId/stats/journeys` | `read:stats` | The paths visits took, entry and three pages on |
| `GET /api/sites/:siteId/export.csv` | `read:stats` | Any report as a file: `report=` names the kind, absent means a breakdown |
| `PUT /api/sites/:siteId/share` | `admin` | Make the public share, regenerate its link, set or clear its password |
| `DELETE /api/sites/:siteId/share` | `admin` | Take the share off; answers `{ deleted: true }` |
| `GET /api/share/:token` | nothing | Whose numbers, in which zone, whether a password stands in the way |
| `POST /api/share/:token/unlock` | nothing | The password, for a cookie scoped to this share |
| `GET /api/share/:token/stats/aggregate`, `/timeseries`, `/breakdown`, `/goals`, `/annotations` | the link, and the cookie when locked | The report's own route and shape, on `read:stats` alone |
| `GET /api/sites/:siteId/realtime` | `read:stats` | Who is here now |
| `GET /api/sites/:siteId/realtime/stream` | `read:stats` | The same, as server sent events |
| `GET /api/sites/:siteId/visitors/:visitorId` | `read:stats` | Identity fields gated |
| `GET /api/sites/:siteId/users/:userId` | `read:identity` | One identified person |
| `GET /api/sites/:siteId/users/:userId/presence` | `read:identity` | The online badge |
| `POST /api/sites/:siteId/events` | `write:events` | What a backend sends |

### The public share

A site has at most one share (`AN-RPT01`): a link made of a 32 character
token, an optional password, and the Overview's reports under
`/api/share/:token`. The token is the link and is stored as it is; a new token
is the revocation, and there is no second secret. The password is argon2 like
an account's and `PublicSite.share` never carries the hash. A reader who gives
the password gets an HttpOnly cookie scoped to `/api/share/:token`, signed
over the token and over the password's hash, so a regenerated link and a
changed password each end every reader at once. Under the share the report
controllers run unchanged behind a principal of kind `share` holding
`read:stats` on that one site and nothing else: identity, people, realtime,
events, properties and the export are not registered there and answer 404.
Reads are limited per address at `SHARE_RATE_LIMIT` a minute (120) on a
counter of their own, and every answer, like the dashboard's `/share/*` page,
carries `X-Robots-Tag: noindex`.

### The query every report takes

`from` and `to` are required: epoch milliseconds, or an ISO 8601 date or
timestamp. `from` is inclusive, `to` is exclusive, and a range that ends before
it starts is refused rather than answered with zeroes, because zeroes read as
"nobody came".

- `interval=minute|hour|day|week|month`, `day` by default. Neither a minute
  nor an hour has a daily rollup behind it, so both read raw rows for the whole
  range and both are capped: 7 days for hours, 3 hours for minutes. The minute
  interval exists for the live view, where the question is the last half hour.
- `compare=previous_period|previous_year` adds `previous` and `previousRange`.
- `dim=` any dimension, required for a breakdown and for the CSV export.
- `limit=` rows in a breakdown, 100 by default.
- `metrics=visitors,pageviews,visits,bounces,bounce_rate,duration` narrows the
  response. All of them cost the same to compute, so this is about a smaller
  answer and never a cheaper query.
- `filters=` in either of two spellings. A dashboard sends JSON:
  `filters=[{"dim":"page","op":"is","value":"/pricing"}]`. A person types the
  compact form: `filters=page==/pricing;browser!=Firefox;city~Dhaka`, where `==`
  is `is`, `!=` is `is_not` and `~` is `contains`. The compact form has no escape,
  so a value containing a semicolon has to go as JSON.

- `goal=` a goal's id, on `aggregate`, `breakdown` and `export.csv`. See
  below.
- `report=` on `export.csv` only: `breakdown` (the default), `timeseries`,
  `engagement`, `events`, `properties` (with `event=`), `goals`, `funnel`
  (with `funnel=`) or `journeys`, each with the query its own route takes and
  one fixed column set per kind. A timeseries file carries the compared series
  under `series=previous` after the current one; an unknown key is the word
  `(unknown)` and a journey's Other is `(other)`, never a blank. The file is
  named `<site>-<report>[-<dimension, event or funnel>]-<from>-<to>.csv`. People and realtime are not
  exported: one is identity, the other a snapshot.

`meta` carries the site, its timezone and the range that was read, so a chart can
label itself without drawing a day boundary a second time.

### Route grouping

A site with dynamic pages, `/courses/competitive-programming` and a hundred
like it, reads better as one row. `settings.routeGroups` is an ordered list of
path patterns such as `/courses/:slug`, where `:name` is exactly one segment
and `*` is any run of characters inside one, and the `route` dimension reports
every pageview under the first pattern its path matches, or under the path
itself when none does: the route report is the page report with the dynamic
pages folded, and a filter on `route` is a filter like any other. The route is
stamped on each row as it is collected, from the rules as they were then. When
the rules change, the site carries `routesChangedAt` until the hourly job has
rewritten every stored row and rebuilt the `route` rollups of every past day
that still has rows, so history within retention regroups and nothing older
changes. A second process reads a changed rule up to a minute late, the site
row being cached that long.

### Segments

A segment is a named, saved filter list, and nothing more: applying one is
sending its filters to a report, which every report already answers, so a
segment costs the reads nothing new and may hold every dimension, `entry`,
`exit`, `channel`, `route` and `bot` included. Reading the list needs
`read:stats`; adding and deleting need `admin`, because the list is shared by
everybody who reads the site.

```
POST /api/sites/my_site/segments
{ "name": "Mobile from Bangladesh",
  "filters": [{ "dim": "device", "op": "is", "value": "mobile" },
              { "dim": "country", "op": "is", "value": "BD" }] }
```

The filters are the JSON shape `filters=` takes, one to ten of them, stored in
canonical order (dimension, operator, value) with a duplicate dropped. The id
is derived from the site and that list, so the same filters saved again, in
any order and under any name, are `409 SEGMENT_EXISTS` with the existing id in
`details.segmentId`. A site has at most 50 (`409 SEGMENT_LIMIT`), a body that
does not validate is `400 INVALID_SEGMENT` with the issues, and an id that is
not this site's is `404 SEGMENT_NOT_FOUND`. There is no edit route: delete and
add again. `GET` lists them by name.

### Annotations

An annotation is a fact stated about the site at an instant, drawn as a mark
on the chart so a step in the line has its reason beside it: a deploy, a
campaign, an outage, or a note. Reading the range's marks needs `read:stats`,
the scope the chart itself needs; adding and deleting need `write:events`,
because a mark is a fact about the site in the way a server event is, so the
key a deploy pipeline already holds can post one and an editor can note a
campaign from the dashboard.

```
POST /api/sites/my_site/annotations
{ "at": 1758700800000, "kind": "deploy", "text": "v2.3.0",
  "url": "https://github.com/example/app/releases/tag/v2.3.0" }
```

`at` is Unix milliseconds, `kind` is `deploy`, `campaign`, `downtime` or
`note`, `text` is one sentence of at most 200 characters and `url` is
optional. The id is derived from the site, the instant, the kind and the
text, so a pipeline that retries its POST writes one mark and is answered
`409 ANNOTATION_EXISTS` with the existing id in `details.annotationId`. A
site holds at most 1,000 (`409 ANNOTATION_LIMIT`), a body that does not
validate is `400 INVALID_ANNOTATION` with the issues, and an id that is not
this site's is `404 ANNOTATION_NOT_FOUND`. `GET
/api/sites/my_site/annotations?from=&to=` reads the marks with `at` inside
the half-open range, oldest first, which is what the chart asks for beside
its points.

### Goals and conversions

A goal is a page being viewed or a custom event being sent, counted as a
success. Reading the list needs `read:stats`; adding and deleting need `admin`,
the scope site settings need, because a goal changes what every report of the
site says.

```
POST /api/sites/my_site/goals
{ "name": "Signed up", "kind": "event", "match": "signup", "value": 1 }

{ "name": "Checked out", "kind": "page", "match": "/*/checkout/done" }
```

- **`kind: "page"`** matches a pageview's path exactly as the tracker sent it.
  It starts with `/`, and a `*` stands for any run of characters inside one
  segment, so `/*/checkout/done` matches `/en/checkout/done` and not
  `/en/x/checkout/done`. Nothing else is special.
- **`kind: "event"`** matches one custom event name exactly, from a page or from
  a server. A page timing is never a conversion.
- **`value`** is optional, a plain number with no unit, counted once per
  completion.

The id is derived from the site, the kind and the match, so asking the same
question twice is `409 GOAL_EXISTS` with the existing id in `details.goalId`. A
site has at most 50 goals (`409 GOAL_LIMIT`), a body that does not validate is
`400 INVALID_GOAL` with the issues, and an id that is not this site's is
`404 GOAL_NOT_FOUND`, including an id of another site asked with a key bound to
this one. There is no edit route: delete and add again. Deleting loses nothing,
because nothing is counted when a goal is written; a goal is a question asked of
the raw events, which is also why one added today answers for every day the
events still cover.

With `goal=<id>` on `aggregate` the result carries a `conversion` (and a
`previousConversion` with a comparison); on `breakdown` every row carries one;
`export.csv` gains `converted_visitors`, `completions`, `conversion_rate` and
`value`. A conversion is:

```
{ "visitors": 38, "completions": 44, "rate": 0.12, "value": 44 }
```

A visitor converts on a day if a conversion event of theirs happened that day,
on the site's calendar. A row's converted visitors are, day by day, the visitors
counted in that row who also converted that day, added up over the range: the
same arithmetic as visitors, so `rate` never passes 1 and is `null` over nobody.
The conversion event does not have to carry the row's dimension, so an order paid
by somebody who arrived from a campaign that morning counts in that campaign's
row. Filters narrow the people a conversion is counted against, never the goal.
A goal read is raw for its whole range, visitors included, and says so with
`rawOnly: true` and `retentionDays` in the meta. `timeseries` and `engagement`
refuse a goal with `400 UNSUPPORTED_GOAL` rather than ignoring it.

`GET /stats/goals` answers every goal of the site at once, each with its record
and one conversion against the range's visitors.

### Events and properties

`GET /stats/events` lists the range's custom events by name, each with its
visitors, how many times it was sent, and `rate`, its share of the range's
visitors. `GET /stats/properties?event=signup&property=plan` breaks one event down
by one property: `properties` lists the names it carried, most used first (at
most 50), `property` is the one the rows are about (the one asked for, else the
most used), and an event sent without it is the `""` row, so the rows add up to
the event. `event` is required (`400 MISSING_EVENT`). Both read raw rows only,
and neither takes a goal.

A property is something a site chose to report about an event, like a plan, a
quiz id or a button's place on the page, so its values are readable with
`read:stats`; anything about a person belongs in the traits of an identify,
which stay behind `read:identity`.

### Funnels and journeys

A funnel is steps a visitor takes in order, within a window. Reading the list
and the report needs `read:stats`; adding and deleting need `admin`, as goals do.

```
POST /api/sites/my_site/funnels
{ "name": "Checkout", "window": "7d",
  "steps": [ { "goalId": "g_x" }, { "page": "/*/pricing", "name": "Pricing" }, { "goalId": "g_y" } ] }
```

- **A step** is a goal of this site, by id, or a typed path under a page goal's
  rules. A goal step copies the goal's question (its kind and match) when the
  funnel is created and keeps `goalId` only to say where it came from, so
  deleting the goal changes no funnel. `name` is optional on both and defaults to
  the goal's name or the path. 2 to 8 steps.
- **`window`** is `visit`, `1h`, `1d`, `7d` or `30d`: how long a visitor has from
  the first step to the last, or every step inside one stay. Left out, it is `7d`
  on a site that keeps its visitors (`visitorIdMode: persistent`) and `visit` on
  a cookieless one, whose visitor ids are a daily hash that no chain can follow
  across midnight. A server event joins the stay it arrives in under the thirty
  minute rule, so a step a backend confirms minutes later completes a `visit`
  funnel; one that can come later than that belongs in a time window.

The id is derived from the site, the window and the steps in order, so the same
funnel under another name is `409 FUNNEL_EXISTS` with the existing id in
`details.funnelId`. A site has at most 50 (`409 FUNNEL_LIMIT`); a body that does
not validate is `400 INVALID_FUNNEL` with the issues; a goal step naming a goal
that is not this site's is `404 GOAL_NOT_FOUND` with `details.step`, counted
from 0. There is no edit route, and deleting loses nothing.

`GET /stats/funnel?funnel=<id>` (`400 MISSING_FUNNEL` without one, `404
FUNNEL_NOT_FOUND` for an id that is not this site's) answers the funnel, the
segment's `visitors`, and one entry per step:

```
{ "visitors": 120, "dropOff": 45, "rate": 0.6, "stepRate": 0.73 }
```

`visitors` reached this step and every one before it, in order, within the
window; `dropOff` is how many of the previous step did not; `rate` is over the
first step and `stepRate` over the previous one, each `null` over nobody.

- **Counted once per visitor over the whole range, never per day.** A chain
  begun on Monday and finished on Tuesday belongs to neither day. So over more
  than a day the first step is distinct people, not the Visitors figure, which
  adds up each day's uniques; and a funnel is not a goal's conversion, which is
  per day.
- **In order, one row one step.** Anything between two steps is ignored, a
  funnel of `/home` then `/home` needs two views of `/home`, and repeating the
  first step starts a new clock without undoing what an earlier start reached.
  At the same millisecond, rows are taken in step order. The last step may land
  exactly on the window's edge. Every step has to fall inside the range.
- **Filters narrow the people and never the steps.** A visitor is in the segment
  when a row of theirs in the range matches every filter a row carries and, for
  `entry`, `exit` and `channel`, a stay of theirs that began in the range
  matches those. The events and goals reports still refuse those three, because
  they count rows and a row does not know the stay it came in on, while a funnel
  and a journey count people and visits, which do.
- **The first 1,000 step rows of a visitor** in the range are the ones folded.
  No person gets near it; it is what keeps a read that asks for the bots from
  gathering one crawler's hundred thousand rows into one group.

`GET /stats/journeys` answers the paths the range's visits took, from the page
they came in on through the next three: `columns` (four, each a list of nodes
with `visits`, `exits`, where visits ended, and `onward`, which only the last
column has, for visits that went further), `links` from each column to the
next, and the total `visits`. A journey is a visit that began in the range and
viewed a page; a page viewed twice back to back is one step, and the first 50
pageviews of a visit are the ones read. Each column keeps its most visited pages,
`branches=` 1 to 10 of them and 5 by default (`400 INVALID_QUERY` otherwise),
and folds the rest into one Other node, whose `key` is `null`; a visit in Other
keeps the pages after it. It counts visits, not visitors, because a path is a
fact about one visit. Filters narrow the visits and never the path, the same
way. Pages after the end of the range are not read.

Both are raw for the whole range and say so with `rawOnly: true` and
`retentionDays`. Neither takes a goal (`400 UNSUPPORTED_GOAL`), and neither
draws a comparison: `compare` is ignored, as it is on the events report.

The dashboard draws both: Funnels is a destination of its own, and Journeys is a
tab on Pages. A page pressed in the flow filters the report with `page`, the
one of the two that every other card of that report can answer too.

### Time on page and scroll depth

`GET /api/sites/:siteId/stats/engagement?dim=page` answers one row per value
with `avgTimeOnPageMs`, `avgScrollDepth` and `leaves`. Both averages come from
leave beacons, which a browser sends per page rather than per visit, so this is
a measurement and not the gap between two pageviews: the last page of a visit
has no following pageview to subtract from, and it is usually the page worth
knowing about.

Two things the response says out loud. `rawOnly: true`, because no rollup holds
a leave beacon and this report therefore sees exactly as far back as the site
keeps its raw events, with `meta.retentionDays` beside it saying how far that
is. And `leaves`, because it is the sample size: a page with
one leave has an average of one, and a report that hides that is inviting
somebody to act on it. An average over no measurement is `null`, never zero, so
a page somebody closed at once and a page nobody has closed do not read the
same. A dimension only a stay carries (`entry`, `exit`, `channel`) is refused
with `UNSUPPORTED_DIMENSION` rather than answered empty.

### Two ways to be somebody

**A dashboard session.** `POST /api/auth/login` with an address and a password
sets `chokh_session`: `httpOnly`, `SameSite=Lax`, `Secure` in production. The
password is hashed with argon2id.

There is no session table. The cookie carries the user id and an expiry, signed
with `SESSION_SECRET`, and who that user is now is read from the store on every
request. Removing somebody from a team therefore takes effect on their next
request rather than when their cookie runs out. What it costs is revocation:
"sign this person out of every browser" needs a row to invalidate, and nothing
here asks for that yet. Shorten `SESSION_TTL_HOURS` if that trade is wrong for
you.

`SESSION_SECRET` is required in production. Without one the server generates
another on every boot, which signs everybody out on a deploy and, with two
processes, all of the time.

**An API key.** `Authorization: Bearer chk_…`, minted by an owner, belonging to
one site, carrying any of four scopes:

| Scope | Lets the holder |
| --- | --- |
| `read:stats` | Read every report, the realtime snapshot and the stream |
| `read:identity` | See addresses, identified user ids and traits |
| `write:events` | Send server side events |
| `admin` | Change settings, mint and revoke keys, rotate the identify secret |

A key is 256 bits from the system random source and only its SHA-256 hash is
stored: the token is shown once, when it is minted, and a key that was lost is
replaced rather than recovered. SHA-256 and not argon2 on purpose, because there
is nothing to guess about 256 random bits and the lookup has to go through a
unique index. A key cannot be minted carrying a scope its maker does not hold.

A request presenting a key is a program saying which identity it wants used, so a
key beats a cookie and a bad key is refused rather than falling back to whatever
cookie the browser sent.

**Roles.** A team owns sites and holds members. A session's scopes come from the
role it holds in the team that owns the site, so the same person can be an owner
of one team and a viewer of another:

| Role | Scopes |
| --- | --- |
| `owner` | all four |
| `editor` | `read:stats`, `write:events` |
| `viewer` | `read:stats` |

`read:identity` is not in the editor's or the viewer's list. An owner has it by
their role; anybody else only when the `identity` flag is set on their
membership. Reading the numbers and reading who the numbers are about are two
different permissions.

A site with no `teamId` belongs to the team `default`, which is what the first
registered account owns. A fresh install is therefore usable the moment somebody
registers.

### The identity gate and the audit log

An IP address, the `userId` an identify named and the traits that came with it are
personal data about a real person, not facts about traffic. They are behind
`read:identity`, and every response that carries one writes a row to
`audit_log`: who, when, which site, which route, which person and which fields.
The log has no TTL, because "who looked at this person" is asked months later.

- The **realtime list** stays visible to anybody with `read:stats`, with `ip` and
  `userId` removed. The page, the country, the city, the device and the counts
  are traffic. This is the IP column a dashboard hides, not the list. The
  `recent` list goes through the same strip, because it is the same people a few
  minutes earlier.
- **City coordinates are not gated.** They are rounded to two decimal places
  when the presence entry is written, which is about a kilometre, so what is
  kept is where a city is and never where a person is. Nothing finer than that
  is ever in the set for anybody to read later.
- A **visitor profile** is the same: the history stays, the addresses come back
  empty and the name and traits are absent.
- A **user profile** and a **user's presence** are refused outright without the
  scope. To reach either you have to already know the person's id, so the request
  itself is "tell me about this named person", and there is no version of that
  answer with the person taken out.
- The **stream** writes one row when it opens, not one per frame. A frame every
  half second would turn the log into a metronome and bury the reads somebody
  wants to find.
- A read that revealed nothing personal writes nothing. A snapshot of anonymous
  visitors names nobody.

### The realtime stream

`GET /api/sites/:siteId/realtime/stream` is server sent events. A frame on
connect, a frame within half a second of a batch landing, a frame every ten
seconds so the online count decays on its own, and a `:` keepalive every fifteen.
Each frame's `data:` is the success envelope, so a client parses a frame the way
it parses a poll.

The nudge that wakes a stream travels over Redis pub/sub when `REDIS_URL` is set,
so a dashboard on one container wakes on a batch accepted by another, and over an
emitter in this process when it is not. Losing it costs at most ten seconds of
latency, because the refresh timer is still there.

Behind Nginx, turn buffering off for this path or nothing arrives until Nginx
decides it has enough:

```
location /api/sites/ {
  proxy_pass http://127.0.0.1:4100;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

### Server side events

`POST /api/sites/:siteId/events`, with a key carrying `write:events`. For facts a
backend knows and a page either cannot see or cannot be trusted about: an order
that was paid, a signup that completed, an identify for a browser that blocks the
tracker.

```
POST /api/sites/ps_web/events
Authorization: Bearer chk_…

{ "userId": "u_42", "visitorId": "v_from_the_browser",
  "events": [{ "type": "event", "name": "order_paid", "value": 1200 }] }
```

Four rules make it different from `POST /api/collect`:

1. **The identity is trusted and required.** A key presented by a server is the
   proof a browser identify needs a signature for.
2. **It is never a pageview.** A backend did not read a page. Only `event` and
   `identify` are accepted.
3. **It never puts anybody online.** A receipt written by a backend is not a sign
   that somebody is at a keyboard.
4. **It carries no address.** The stay it joins already has the visitor's
   location from the browser.

Which visitor it lands on, in order of preference: the `visitorId` the
application passed, which is best because the event joins the stay in progress;
otherwise the visitor that person was last seen as; otherwise `u:<userId>`, so
somebody who only ever exists server side is still one visitor. The response says
which one it was.

### Single sign-on

`POST /api/sso` with `{ "token": "…" }`, or `GET /api/sso?token=…&next=/realtime`
for a link in another application's admin panel, which sets the cookie and
redirects with a `303`.

The token is an HS256 JWT signed with `SSO_SECRET`, shared with that application:

```
{ "sub": "staff_7", "email": "staff@example.com", "name": "Staff Seven",
  "teamId": "default", "role": "viewer", "identity": false,
  "jti": "<unique>", "iat": …, "exp": … }
```

`sub`, `email` and `jti` are required. `role` defaults to `viewer`. An account is
created on first arrival from these claims, with no password, so somebody who
arrives by SSO cannot sign in with one until they set it; their password belongs
to the other application and this should not be a second place to guess it.

Three things keep a five minute token from being a five minute password. The
signature has to be ours, and the algorithm is asserted rather than read out of
the header. The lifetime is bounded by `SSO_MAX_AGE_SECONDS`, so a token claiming
a longer one is refused however well it is signed. And the `jti` is single use,
in Redis when there is one and in this process otherwise, so a token read out of a
URL, a proxy log or a browser history cannot be presented twice. Raising
`SSO_MAX_AGE_SECONDS` weakens all three, and the `GET` form is the reason they
exist: it puts the token in a URL.

An install with no `SSO_SECRET` refuses every exchange. An SSO endpoint nobody
configured is an open door.

### There is no CORS

Deliberately. The dashboard is served by this same process, so it is same origin,
and a backend consuming this API calls it server to server and proxies the stream
itself. `POST /api/collect` needs no CORS either: a beacon is a simple request and
the origin check is the site's allowlist.

Adding `Access-Control-Allow-Origin: *` here would let any page on the internet
read a site's numbers with the visitor's own cookie. If a cross origin consumer
ever appears it gets an allowlist and a reason written down, never a wildcard.

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
the session start. The snapshot carries two lists: `visitors`, who are online
now and are what `online`, `signedIn` and `anonymous` count, and `recent`, the
rest of the half hour window, newest first and capped at fifty, counted in
nothing. A quiet hour should not read as a broken page. `byCity` is the live
map: one row per city and country pair, with the coordinates to draw it.
Crawlers are in neither list and in none of the counts. Presence is not storage: it is a
minute's window over a half hour set, rebuilt by the next heartbeat, so losing
Redis costs the online count for a minute and nothing else.

## The jobs

Four, all idempotent, all safe to run twice, none holding a lock, so two
processes of one install need no leader between them.

- **The route regroup**, on the hourly tick, for a site whose route rules
  changed since the last one: every stored row takes the route the rules give
  it now, the `route` rollups of every past day that still has rows are
  rebuilt, and the mark comes off the site. It runs before the rollup, so the
  day rolled on the same tick already carries the new routes.
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
| `REAL_IP_HEADER` | `X-Forwarded-For` | Or `CF-Connecting-IP`, honoured only from a trusted peer, or `X-Chokh-Forwarded-For`, honoured only when signed |
| `CHOKH_PROXY_SECRET` | none | Shared with your first-party proxy, which signs the address it forwards. Required for `REAL_IP_HEADER=X-Chokh-Forwarded-For` |
| `GEOIP_DIR` | `./data/geo` | Where the geo database lives |
| `GEOIP_LICENSE_KEY` | none | Chooses GeoLite2-City over the keyless fallback |
| `COLLECT_RATE_LIMIT_IP` | `3000` | Batches a minute from one address |
| `COLLECT_RATE_LIMIT_SITE` | `60000` | Batches a minute for one site |
| `MONGODB_URI` | none | Set it and the server runs on MongoDB, unset and it runs on memory |
| `REDIS_URL` | none | Presence, the realtime nudge and the SSO replay set in Redis rather than in this process |
| `SESSION_SECRET` | none | Signs the dashboard session cookie. Required in production |
| `SESSION_TTL_HOURS` | `12` | How long a session lasts |
| `SSO_SECRET` | none | Shared with the application that mints SSO tokens. Unset means SSO is refused |
| `SSO_MAX_AGE_SECONDS` | `300` | The longest life an SSO token may claim |
| `AUTH_RATE_LIMIT` | `10` | Sign-in, registration and SSO attempts a minute, per address |
| `COOKIE_SECURE` | yes in production | `false` lets a developer sign in over plain http |

`CHOKH_LICENSE_KEY` and the five variables that say where alerts go
(`CHOKH_SMTP_URL`, `CHOKH_BREVO_API_KEY`, `CHOKH_MAIL_FROM`,
`CHOKH_TELEGRAM_BOT_TOKEN`, `CHOKH_PUBLIC_URL`) are read by `packages/ee` and
by nothing here; see
[its README](../ee/README.md).

An install running more than one process should have `REDIS_URL`. Without it each
process keeps its own presence set, its own realtime nudges and its own record of
which SSO tokens have been used, so the online count differs between them, a
dashboard only wakes on batches its own process accepted, and one SSO token can be
exchanged once per process. None of the three is storage, so losing Redis costs a
minute of "online now" and nothing else.

Behind Cloudflare, set `TRUST_PROXY` to Cloudflare's ranges and `REAL_IP_HEADER`
to `CF-Connecting-IP`, or every visitor's address is Cloudflare's. If your proxy
already resolves the Cloudflare hop and hands on `X-Forwarded-For`, leave
`REAL_IP_HEADER` alone and set `TRUST_PROXY` to that proxy.

Behind a first-party proxy of your own, neither of those two can work, because
the proxy is the peer and its address range is not yours to trust. Set
`REAL_IP_HEADER` to `X-Chokh-Forwarded-For` and share a `CHOKH_PROXY_SECRET`
with it instead. See [A first-party proxy](#a-first-party-proxy). The mode
without the secret is refused at boot: the header would be one anybody could
set.

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

**MongoDB 5.0 or newer.** A property value is read with `$getField`, which 5.0
introduced, so that a property name with a dot or a dollar in it stays a name,
and the funnel and journeys reads cap each visitor's rows with
`$setWindowFields`, 5.0 as well.
The adapter reads the server's version once when it opens and the boot log
line that names the storage adapter carries it (`"store":"mongodb","version":"7.0.24"`).

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
  carries them. A filter on one of those three narrows a report to the stays
  that match it: the rows of those stays are what is counted, and the visit
  numbers come off the stays themselves. A row written before stays were
  stamped belongs to no stay and is out of such a report.

## Things to know before you point a site at this

- **A site can keep its own traffic out.** `settings.excludeIps` (addresses
  or CIDR ranges), `settings.excludePaths` (absolute paths, `*` for one
  segment) and `settings.excludeQueryParams` are applied by the collector
  before a row is derived: a batch from an excluded address answers `202` and
  stores nothing, an event on an excluded path is dropped and the rest of its
  batch kept, and the named parameters are stripped off any path or referrer
  that carries a query string. The tracker never sends the page's own query
  string, only the UTM parameters as attributes, so that last list matters
  for hash routes, server side events and referrers. A rate limit is counted
  before an exclusion is read, and a rule the collector could not apply is
  refused by the settings rather than stored as a silent no-op.
- **The origin check is by exact hostname.** `example.com` and `www.example.com`
  are two entries. A subdomain is not covered by its parent.
- **A page served with `Referrer-Policy: no-referrer` sends `Origin: null` on a
  cross-origin beacon, and no `Referer` at all**, so there is nothing to check it
  by and the batch is refused. Serve the tracker and the collect path through a
  first-party proxy path on your own domain (`data-api="/_pa"`), which is worth
  doing anyway because filter lists do not carry it. A proxy has to carry the
  visitor's address across: see [A first-party proxy](#a-first-party-proxy).
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

## The load test

```
pnpm load:collect           the in-memory adapter
pnpm load:collect --mongo   a real mongod, so the database writes are in the number
```

`POST /api/collect` at 200 requests a second for twenty seconds, asserting a 95th
percentile under 20 ms. Not in CI: a shared runner's p95 is noise, and a gate that
fails for somebody else's noisy neighbour teaches people to ignore gates.

Every request is a different visitor sending a custom event, because the two
obvious shapings measure the wrong thing. All the traffic arrives from one address
with one user agent, so in cookieless mode the collector would derive one visitor
id for all of it and every batch would land on one session document, which is a
write hotspot no real site has. And a repeated pageview is one pageview, so a
constant path would be swallowed by the dedupe and the store would barely be
touched. The script says so where it shapes the load.

## Layering

`routes/` register, `controllers/` validate with Zod and return the envelope,
`services/` hold the logic, `store/` is the only place that knows storage. See
[AGENTS.md](../../AGENTS.md) section 5.
