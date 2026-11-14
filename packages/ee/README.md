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
| `src/teams/teams.routes.ts` | Making a team, deleting one, moving a site between two |
| `src/oidc/client.ts` | The provider's end of a sign-in: discovery, the code exchange, and what an ID token has to say to be believed |
| `src/oidc/oidc.routes.ts` | The flow: leaving, coming back, connecting an account, using an invitation |

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
| `CHOKH_BREVO_API_KEY` | The other way to send email: over HTTPS through Brevo's API, for a host whose outbound SMTP ports are closed (DigitalOcean closes 25, 465 and 587 by default). With `CHOKH_MAIL_FROM`, turns on the email channel; when both this and the SMTP URL are set, the API is used |
| `CHOKH_MAIL_FROM` | The address messages come from, whichever way they go |
| `CHOKH_TELEGRAM_BOT_TOKEN` | The token BotFather hands out. Turns on the Telegram channel; the chat id is on each alert |
| `CHOKH_PUBLIC_URL` | Where this dashboard is reached from outside, so a message can carry a link to the Alerts page |

All five are optional and read by `src/license/env.ts`, the one environment
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

## Digests

The second paid feature (`AN-RPT01`): the site's numbers, mailed. A daily
digest is yesterday, a weekly one the seven days ending yesterday, both in
the site's own zone, at an hour of the site's day (8 unless chosen) and, for
a weekly one, on a weekday (Monday unless chosen). Each mail carries the
numbers against the period before, the shape of the day by hour or the week
by day, the top five pages, sources and countries, the goals' conversions
and the marks on the chart, as text, as HTML, and as one page attached,
drawn with `pdf-lib` (a dependency of this package and of nothing in the
core, like `nodemailer`). Email goes the way alerts' email goes: Brevo's API
when `CHOKH_BREVO_API_KEY` is set, SMTP otherwise, from `CHOKH_MAIL_FROM`.

A site has at most one digest per cadence, the id derived from both, and
each goes to one to five addresses. The tick runs beside the alert tick every
five minutes: a digest whose hour has come and whose period is not yet
claimed is composed and sent once, the claim being one compare-and-set write
on the row, so every process may tick and each period goes once. A period
whose mail reached nobody stays claimed, because a digest that arrives twice
is worse than one that arrives late; the row keeps what happened (`last`)
and the Alerts page shows it.

```
GET    /api/sites/:siteId/ee/digests                  read:stats
POST   /api/sites/:siteId/ee/digests                  admin
DELETE /api/sites/:siteId/ee/digests/:digestId        admin
POST   /api/sites/:siteId/ee/digests/:digestId/send   admin
```

```
POST /api/sites/my_site/ee/digests
{ "cadence": "weekly", "to": ["ops@example.test", "founder@example.test"],
  "hour": 8, "weekday": 1 }
```

The feature is `digests`. The list's `meta` says whether this install can
mail at all (`mail`) and what it lacks (`needs`), and a `POST` on an install
that cannot is `400 CHANNEL_UNAVAILABLE` naming the variable. A second digest
of the same cadence is `409 DIGEST_EXISTS`; there is no edit route, delete
and add again. `send` mails the last complete period now, whatever the hour,
and answers each address's outcome; it does not claim the period, so the
scheduled send still goes at its hour.

## More than one team

Behind the feature `teams`. What is paid is three acts and nothing else:
making a team, deleting one, and moving a site from one to another. A team that
exists goes on working with no key: its members, its sites, its invitations and
its audit log are the core's, and so is a team the SSO exchange made on
somebody's first arrival. A key that lapses takes nothing away. It refuses the
next new team.

```
POST   /api/ee/teams               a person who owns some team
DELETE /api/ee/teams/:teamId       a person who owns that team
PUT    /api/ee/sites/:siteId/team  a person who owns the team the site is in, and the one it goes to
```

Never a key: who is in which team, and which team reads which site, is a
person's decision. Each route asks who is calling first and about the licence
second, so somebody who owns nothing is told that and not which feature lives
there.

```
POST /api/ee/teams   { "name": "Clients" }
201  { "team": { "id": "t_3f9a1c20", "name": "Clients", "role": "owner" } }
```

Whoever makes a team owns it, alone, and it holds no site until one is created
in it (`POST /api/sites` with its `teamId`, which is the core's) or moved to
it. One person owns at most 50 (`409 TEAM_LIMIT`).

**Deleting.** Never the team `default` (`409 DEFAULT_TEAM`), and never one that
still holds a site (`409 TEAM_HAS_SITES`): move its sites first. The
invitations waiting on it go with it, and their links then open nothing.

**Moving a site.** `PUT /api/ee/sites/:siteId/team { "teamId": "t_3f9a1c20" }`.
From the next request the team it left no longer reads it and the team it
joined does; nothing is cached in a session that would say otherwise. The
roles held on the site itself (somebody invited to that one site) are rows
about the site and go with it untouched. The move is written to three logs:
the team it left, the team it joined, and the site's own.

A key goes on working whoever made it. So when keys on the site were made by
people who will not administer it after the move, the move is refused
`409 KEYS_DECISION_REQUIRED` with the list (id, name, scopes, never a token)
until the request says `revokeKeys: true` or `false`, the question a removal
asks.

**Two things at the same instant.** A team that holds a site is not deleted,
and that has to hold when a site is created in a team, or moved to it, while
that team is being deleted. The store looks and then writes, so each side
looks again after its own write: between the two looks every order of the
steps is seen by one of them, and whichever sees it puts the team back as it
was. The deletion then answers `409 TEAM_HAS_SITES`. The one loss is the
invitations that were waiting on the team, which went with it.

## Single sign-on (OpenID Connect)

Behind the feature `oidc`, and switched on by four values, all of them or it
is off:

```
CHOKH_OIDC_ISSUER=https://id.example.com
CHOKH_OIDC_CLIENT_ID=...
CHOKH_OIDC_CLIENT_SECRET=...
CHOKH_PUBLIC_URL=https://analytics.example.com
```

Register `<CHOKH_PUBLIC_URL>/api/ee/oidc/callback` with the provider as the
redirect address. It is built from `CHOKH_PUBLIC_URL` and never from a
request's `Host` header.

**Copy the issuer exactly as the provider's own discovery document states
it**, the slash at the end included when it has one (Auth0's does:
`https://tenant.auth0.com/`). An issuer is a name that is compared character
for character with what the provider says in that document and in every
token; with one slash more or less it is a different issuer, and sign-in
answers `OIDC_UNAVAILABLE`. If some of the four are set and not all, one line at
boot names the ones that are missing, never a value. The client secret goes
from the environment to the one request that exchanges a code: it is never
stored, logged, shown or sent to the dashboard.

**Who somebody is** is the pair the provider vouches for, its issuer and its
subject for the person. **Never the address in a token, verified or not.** So
a sign-in by an identity no account is connected to signs in nobody and makes
nothing, and an account comes to be connected in one of two ways, both
somebody's own act:

- It connects itself, signed in, from the Team page (`POST /api/ee/oidc/link`).
  The return has to arrive in the session that began it.
- It is made from an invitation, by somebody who chose single sign-on on the
  invitation page (`POST /api/ee/oidc/invite`). The account gets the
  invitation's address, never the provider's, and no password.

An address that already has an account is never entered by an invitation and a
provider: that account signs in and connects itself.

```
GET    /api/ee/oidc            anybody: { enabled }, which is all the sign-in page needs
GET    /api/ee/oidc/start      anybody: sends the browser to the provider
GET    /api/ee/oidc/callback   where the provider sends it back
POST   /api/ee/oidc/invite     anybody holding an invitation: { token } in, { url } out
POST   /api/ee/oidc/link       a person signed in: { url } out
GET    /api/ee/oidc/identity   a person signed in, key or no key: { enabled, connected, canDisconnect }
DELETE /api/ee/oidc/identity   a person signed in, key or no key: disconnect
```

The last two ask for no licence. Reading one's own connection, and taking
away a way in to one's own account, are never the paid thing: a key that
lapsed takes nothing away, and that includes being able to shut a door.

**Where it lands afterwards.** `start` takes `next`, a path of this dashboard
to go to once signed in. It is held to the rule the core keeps for its own
exchange (`packages/server/src/lib/safe-next.ts`): an allow-list of
characters and not a prefix, because a browser reads `/\host` and a path with
a tab or a line break in it as another host. Anything else lands on `/`.

**How often.** A sign-in is counted by address on a count of its own, 60 a
minute (a sign-in is a departure and a return, so thirty people a minute from
one office). It is never the password route's count: `start` is a `GET` that
any page can make a browser send, and it must not be able to use up the
attempts somebody has left to sign in with a password. For the same reason a
`start` that the browser says another site began (`Sec-Fetch-Site` present
and neither `same-origin` nor `none`) begins no flow, sets no cookie and is
not counted: a browser is sent to `/login`, where the button is, and a
program gets `403 CROSS_SITE_REQUEST`. And a return is counted only once its
cookie has opened and its state has matched, so a return this browser never
began costs the address nothing.

**In the log.** These two routes are logged by their path alone: the query of
one holds where somebody was going and the query of the other what the
provider sent back, and neither belongs in a log line.

**The flow** is the authorization code flow with PKCE (`S256`), a `state` and
a `nonce`, each 32 random bytes. They travel with the browser in one cookie:
sealed (AES-256-GCM under a key derived from the session secret, so the
browser can neither read nor change it), `HttpOnly`, `SameSite=Lax`, ten
minutes, sent to the callback's path and nowhere else. The callback is a `GET`
that ends in a session, and that cookie is what protects it: a return that
arrives in a browser that did not begin a flow has none and is refused before
the provider is asked anything. The `state` is spent when it is used, so a
return replayed in the same browser is refused as well.

**The ID token** is verified by [`jose`](https://github.com/panva/jose)
(6.2.17, MIT, no dependencies, pinned exactly), which is told: asymmetric
algorithms only; the issuer, which also has to be the one the provider's own
discovery document declares; the audience, and the authorized party when a
token names one; the nonce; not expired, not issued in the future, not older
than ten minutes, with a minute for two clocks to differ. A key id it has not
seen makes it read the provider's keys again, at most once in thirty seconds.
Discovery, keys and the token endpoint are reached over `https` only (plain
`http` on a loopback address, for a test), with a five second limit and no
redirect followed. No token from the provider is kept once the callback has
answered; the session is the ordinary cookie.

**Nobody is locked out by it.** The password route is not touched: a team
that has an owner with a password keeps one (the core's rule), so a provider
that is down, or a key that has lapsed, leaves every account with a password
able to sign in. An account made from an invitation by single sign-on has no
password, so its identity is its only way in and cannot be disconnected
(`409 ONLY_WAY_IN`).

Removing somebody from a team does not delete their account or their
connection: it ends their sessions and takes away what the team gave them.
They can still sign in, to an account that reads nothing, until they are
invited again.

Connecting and disconnecting are written to the audit log
(`identity:link`, `identity:unlink`), with the issuer and never the subject.

The provider in the tests is started inside the test process on a loopback
port, with keys generated for the run, and can be told to lie about each
thing above. `pnpm --filter @chokh/ee run test:browser` runs the flow in a
real browser with the provider and the server on two sites.

## The fixture route

`GET /api/sites/:siteId/ee/ping`, behind the feature `ee.ping`. It is the one
route whose only job is to answer "is the gate working on this install", which
an operator who has just pasted a key in wants to ask without buying anything
else first.
