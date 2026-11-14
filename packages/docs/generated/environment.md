---
title: Environment variables
lead: Everything the server reads from its environment, and what each one does.
description: Every environment variable a Chokh install reads, with its default.
---

This page is generated from `packages/server/src/config/env.docs.json` and
`packages/ee/src/env.docs.json`, which a test holds to the variables the code
reads. To change a sentence here, change it there.

## The server

- **`AUTH_RATE_LIMIT`**, default `10`. Sign-in and registration attempts a minute per address; the single sign-on exchange, and looking at and using an invitation, each on a count of their own.
- **`CHOKH_PROXY_SECRET`**, default none. Shared with your first-party proxy, which signs the address it forwards. At least 32 characters. Required for `REAL_IP_HEADER=X-Chokh-Forwarded-For`.
- **`COLLECT_RATE_LIMIT_IP`**, default `3000`. Batches a minute from one address. High, because a campus or an office is one address.
- **`COLLECT_RATE_LIMIT_SITE`**, default `60000`. Batches a minute for one site.
- **`COOKIE_SECURE`**, default `true` in production. `false` lets a developer sign in over plain http.
- **`DASHBOARD_DIR`**, default the dashboard package's `dist`. The built dashboard to serve. The image sets it.
- **`DATABASE_POOL_SIZE`**, default `10`. Connections to PostgreSQL this process may hold, 1 to 200.
- **`DATABASE_STATEMENT_TIMEOUT_MS`**, default `30000`. How long one PostgreSQL statement may run before the server cancels it.
- **`DATABASE_URL`**, default none. A `postgres://` or `postgresql://` URL: runs the server on PostgreSQL.
- **`GEOIP_DIR`**, default `./data/geo`. Where the geo database is kept.
- **`GEOIP_LICENSE_KEY`**, default none. A MaxMind licence key: GeoLite2-City instead of the keyless fallback database.
- **`HOST`**, default `127.0.0.1`. The address the server listens on. `0.0.0.0` in a container.
- **`INVITE_TTL_HOURS`**, default `168`. How long an invitation can be used, 1 to 720 hours.
- **`LOG_LEVEL`**, default `info`. How much the log says: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. A line never holds a query string, a token or a visitor's address.
- **`MONGODB_URI`**, default none. Runs the server on MongoDB. Set this or `DATABASE_URL`, never both.
- **`NODE_ENV`**, default `development`. `production` makes `DATABASE_URL` or `MONGODB_URI` and `SESSION_SECRET` required, and session cookies secure.
- **`PORT`**, default `4100`. The port the server listens on.
- **`REAL_IP_HEADER`**, default `X-Forwarded-For`. Or `CF-Connecting-IP`, believed only from a trusted range, or `X-Chokh-Forwarded-For`, believed only when signed with `CHOKH_PROXY_SECRET`.
- **`REDIS_URL`**, default none. Who is online now, the realtime nudge and the record of used single sign-on tokens kept in Redis rather than in this process. Needed when more than one process runs.
- **`SESSION_SECRET`**, default none. Signs the dashboard's session cookie. At least 32 characters. Required in production; without it one is made at each start and everybody is signed out.
- **`SESSION_TTL_HOURS`**, default `12`. How long a session lasts, up to 720.
- **`SHARE_RATE_LIMIT`**, default `120`. Reads of a public share a minute per address.
- **`SSO_MAX_AGE_SECONDS`**, default `300`. The longest life a single sign-on token may claim, up to 3600.
- **`SSO_SECRET`**, default none. Shared with the application that mints single sign-on tokens. At least 32 characters. Unset, the exchange refuses everything.
- **`TRUST_PROXY`**, default none. Comma separated address ranges allowed to say who a visitor is.

## The paid features

Read only when `packages/ee` is loaded, and the features they configure run
only with a licence key that names them.

- **`CHOKH_BREVO_API_KEY`**, default none. Email over Brevo's API instead of SMTP, for a host whose mail ports are closed. With `CHOKH_MAIL_FROM`, turns on email; used when both are set.
- **`CHOKH_LICENSE_KEY`**, default none. The licence key that turns on the paid features it names. Checked on the server; nothing is sent anywhere to check it.
- **`CHOKH_MAIL_FROM`**, default none. The address alert and digest email comes from.
- **`CHOKH_OIDC_CLIENT_ID`**, default none. Single sign-on: the client id the provider gave this install.
- **`CHOKH_OIDC_CLIENT_SECRET`**, default none. Single sign-on: the client secret the provider gave this install.
- **`CHOKH_OIDC_ISSUER`**, default none. Single sign-on: the provider's issuer, copied exactly as its discovery document states it.
- **`CHOKH_PUBLIC_URL`**, default none. Where the dashboard is reached from outside, so an alert can link to it and single sign-on can name its return address.
- **`CHOKH_SMTP_URL`**, default none. `smtp://user:pass@host:587` or `smtps://...`. With `CHOKH_MAIL_FROM`, turns on email for alerts and digests.
- **`CHOKH_TELEGRAM_BOT_TOKEN`**, default none. A Telegram bot's token. Turns on Telegram for alerts; the chat is set on each alert.
