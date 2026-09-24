# Chokh Pro

**Everything in this directory is under the [Chokh Enterprise Licence](LICENSE),
not the MIT licence the rest of this repository carries.** You may read it,
compile it and modify it; running it in production needs a licence key. The line
between what is free and what is not is in the [root README](../../README.md)
and in [CONTRIBUTING.md](../../CONTRIBUTING.md), and the reasoning is ADR-0073
in the Progsity workspace.

Nothing here is required by anything in the core. Delete this directory and the
product still builds, boots and serves every report, which is what makes the
free half a complete product rather than a demo. CI proves that on every push.

## How it is loaded

`packages/server/src/lib/load-extensions.ts` imports `../../../ee/dist/index.js`
in a try and catch. Present, and the server registers what it exports; absent,
and the server logs `extensions: absent` at info and carries on. A path and not
a package name, because a declared dependency would be a cycle: this package
depends on `@chokh/server`, and nothing in the core depends on this one.

`src/index.ts` exports one `ServerExtension`: a name, a `register` that adds
routes, and a `license` that answers `GET /api/license`.

## The licence key

One string, pasted into `CHOKH_LICENSE_KEY`:

```
CHOKH-<base64url of the payload JSON>.<base64url of the Ed25519 signature>
```

It is verified offline, against public keys compiled into the build. **Nothing
calls home, ever.** A self-hoster chose this product because it does not tell
anybody who reads their dashboard, and a licence check that phoned home would be
the one request in the whole install that reported on the install itself.

The payload names the licensee, the plan, the features, an expiry, and `seats`
and `sites`, which are `null` on every key the first plan issues: Chokh Pro is
per install, one company and one server on one key, with as many sites and as
many people on it as they like. There is no install id and no machine
fingerprint, on purpose: either the issuer would have to know the install before
issuing, or the install would have to report itself.

The signature is checked once, when the process starts. The expiry is checked on
every request, so a key that runs out at midnight stops working at midnight on a
process that has been up for a month.

| File | What it is |
| --- | --- |
| `src/license/payload.ts` | What a key says, as a Zod schema |
| `src/license/token.ts` | The wire format, and Ed25519 either way |
| `src/license/verify.ts` | Offline verification, and every named refusal |
| `src/license/public-key.ts` | The public keys this build believes |
| `src/license/env.ts` | The only reader of `CHOKH_LICENSE_KEY` in the repository |
| `src/license/state.ts` | The key once, the clock every time |
| `src/license/guard.ts` | `requireLicense(feature)`, and the 403 |
| `src/alerts/conditions.ts` | What an alert asks, as a schema, and the arithmetic that answers it |
| `src/alerts/evaluate.ts` | The tick: claim, read, decide, say so |
| `src/alerts/deliver.ts` | Email, Telegram and the signed webhook behind one interface |
| `src/alerts/messages.ts` | Every sentence an alert says |

### The public keys are empty

`PUBLIC_KEYS` ships as an empty list, so this build believes nobody and refuses
every key. That is correct for a build whose issuer has not put their public key
in the source. The private half belongs to the founder, is generated on their own
machine, and is in no repository, image or CI secret.

## `chokh-license`

```
chokh-license keygen --out ~/.chokh
chokh-license mint --key ~/.chokh/chokh-license.key \
  --licensee "A Company Ltd." --features "*" --expires 2028-09-20
chokh-license show   "$CHOKH_LICENSE_KEY"
chokh-license verify "$CHOKH_LICENSE_KEY"
```

`keygen` writes the private key to a file with owner-only permissions and never
prints it. A secret on stdout is a secret in a shell history, a terminal
scrollback and whatever is recording the session, and this one cannot be rotated
quietly: every key ever minted with it is signed by it. For the same reason it
refuses to overwrite a pair that already exists without `--force`.

A trial is not a feature, it is a short key: `--plan trial --days 30`.

The signing pair is rotated by adding the new public key to `PUBLIC_KEYS` in one
release, minting with the new private key from then on, and dropping the old
entry a release later. A customer's key is rotated more often and differently: a
new key with a later expiry, swapped into one environment variable.

## Writing a paid route

```ts
app.get(
  '/api/sites/:siteId/ee/thing',
  { preHandler: [requireSiteScope(auth, 'read:stats'), requireLicense(state, 'thing')] },
  () => ok({ ... }),
);
```

Two hooks, in that order, and **`requireLicense` is built at each registration
and never hoisted into a shared array**. A preHandler array reused across routes
gives every route the first route's hook, which in this workspace once gave every
route the first route's rate limiter and was found only by an HTTP probe. Here it
would give every paid route the first one's feature name, so a key naming alerts
would quietly open replay. There is a probe in `src/routes/ee.routes.test.ts`
that registers two routes with two features and asserts each names its own.

The scope hook first, always: somebody guessing at paths is refused for the
session they do not have, and is never told which paid feature lives behind one.

Without a licence every paid route answers `403` in the usual envelope:

```json
{ "success": false, "error": { "code": "LICENSE_REQUIRED",
  "message": "...", "details": { "feature": "thing", "reason": "missing" } } }
```

One status for every reason. A customer whose key ran out and a stranger with no
key meet the same door; the dashboard is where the difference is explained, to
somebody who is signed in.

## Alerts

The first paid feature. An alert is a question asked of the numbers every five
minutes, and a message when the answer changes: on Telegram, by email, or to a
webhook. Four kinds:

| Kind | What it watches |
| --- | --- |
| `traffic` | Visitors or pageviews in the last completed hour, against the median of the same weekday's same hour over the previous four weeks, up or down by a percentage. A `minimum` is the floor either side has to reach, so three visitors at 3 am becoming nine is never "up 200%". A week that reads nothing is left out of the median, and fewer than two weeks left is no baseline at all, so a new site's second week never alarms |
| `goal` | Conversions of one goal in a sliding window of 15, 60, 360 or 1,440 minutes, at or above a count or below it. "No signup for a day" is below 1 in 1,440, and a `404` custom event under a goal is an error alert for a site that labels its not-found page that way |
| `errors` | Pageviews the page labelled with a `status` of the class (`4xx`, `5xx` or `any`, meaning 400 and up) in the window, at or above a count |
| `silence` | No pageview for a number of minutes, on a site that had one in the day before the window, so a site nobody has installed yet never alarms |

An alert speaks once per episode: "fired" when its condition first holds,
"back to normal" when it first stops, and nothing in between. The rows keep
the last twenty transitions with each channel's outcome, which is what the
Alerts page shows. A delivery that reached nobody leaves the state where it
was, so the next bucket says it again rather than an outage going unannounced
because a mail server blinked.

The tick runs in every process of an install. Each alert's bucket (the hour
for `traffic`, the five-minute tick for the rest) is claimed through the
store in one compare-and-set write, so two processes evaluate each bucket
once between them, with no leader and no lock. A key that has run out stops
the messages the way it stops the routes.

### Where the messages go

| Variable | What it does |
| --- | --- |
| `CHOKH_SMTP_URL` | `smtp://user:pass@host:587` or `smtps://...`, the one string every mail provider documents. With `CHOKH_MAIL_FROM`, turns on the email channel |
| `CHOKH_MAIL_FROM` | The address messages come from |
| `CHOKH_TELEGRAM_BOT_TOKEN` | The token BotFather hands out. Turns on the Telegram channel; the chat id is on each alert |
| `CHOKH_PUBLIC_URL` | Where this dashboard is reached from outside, so a message can carry a link to the Alerts page |

All four are optional and read by `src/license/env.ts`, the one environment
reader this package has. A channel the install cannot send on is refused when
the alert is created (`400 CHANNEL_UNAVAILABLE`, naming the variable), and the
list route's `meta.channels` says which kinds this install can send, so the
form offers those only. Webhooks need nothing: a `POST` of JSON to the URL,
`user-agent: Chokh`, and when the channel has a `secret`, an
`X-Chokh-Signature: sha256=<hex HMAC-SHA256 of the body>` header the receiver
recomputes. A `2xx` is delivered; a network error or a `5xx` is tried once
more after five seconds; anything else is written down as failed. Email goes
through `nodemailer`, a dependency of this package and of nothing in the core.

### The routes

All under `/api/sites/:siteId/ee/alerts`, behind the feature `alerts`, each
with the scope hook first and its own `requireLicense` second.

```
GET    /api/sites/:siteId/ee/alerts               read:stats
POST   /api/sites/:siteId/ee/alerts               admin
DELETE /api/sites/:siteId/ee/alerts/:alertId      admin
POST   /api/sites/:siteId/ee/alerts/:alertId/test admin
```

```
POST /api/sites/my_site/ee/alerts
{ "name": "Big drop",
  "condition": { "kind": "traffic", "metric": "visitors", "direction": "down",
                 "percent": 50, "minimum": 20 },
  "channels": [{ "kind": "telegram", "chatId": "-1001234567890" },
               { "kind": "webhook", "url": "https://example.test/hooks/chokh",
                 "secret": "a-shared-secret-long-enough" }] }
```

The id is derived from the site and the condition, so one question is one
alert: the same condition under another name is `409 ALERT_EXISTS` with the
existing id in `details.alertId`. A site has at most 20 (`409 ALERT_LIMIT`),
one to five channels each, and a `goal` alert names a goal the site has. There
is no edit route and no pause: delete and add again. The list carries each
alert's `state` (`firing`, `since`), its `recent` transitions, and `watches`,
the condition as one sentence. The test route sends a test message on every
channel now and answers each channel's outcome, which is how a person proves
a bot token or an SMTP password without waiting for a spike.

## The fixture route

`GET /api/sites/:siteId/ee/ping`, behind the feature `ee.ping`. It is the one
route whose only job is to answer "is the gate working on this install", which
an operator who has just pasted a key in wants to ask without buying anything
else first.
