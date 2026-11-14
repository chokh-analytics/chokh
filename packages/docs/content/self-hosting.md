---
title: Self-hosting
lead: Run Chokh on a machine of your own with Docker Compose, put it behind TLS, and keep it up to date.
description: Run Chokh with Docker Compose on PostgreSQL or MongoDB, behind a proxy, with backups and upgrades.
---

Chokh is one server process with a database beside it. The compose files in
the repository build it and start everything it needs.

## What you need

- A machine with Docker and Docker Compose. Chokh runs on PostgreSQL 15 or
  newer, or MongoDB 5.0 or newer; the compose files bring their own.
- A domain name for the dashboard, such as `analytics.example.com`, and a
  proxy that serves it over TLS (Caddy, nginx, or your host's).

## Start it

PostgreSQL is the default. The compose file starts PostgreSQL 17 and Redis,
creates the tables, then starts the server on `127.0.0.1:4100`. MongoDB has a
file of its own, and its indexes are made with one command.

```bash PostgreSQL
git clone https://github.com/chokh-analytics/chokh.git
cd chokh
docker compose up -d
```

```bash MongoDB
git clone https://github.com/chokh-analytics/chokh.git
cd chokh
docker compose -f docker-compose.mongodb.yml up -d
docker compose -f docker-compose.mongodb.yml exec server node packages/store-mongo/dist/migrate.js --apply
```

Open `http://localhost:4100` and register: the first account owns the
install. Then add a site and put the tag on it, as in the
[quickstart](/quickstart/).

## Before anybody else can reach it

As shipped, both compose files are for one machine: the server is published
on `127.0.0.1` only, the database not at all, and the session secret and the
database password are development values anybody reading the repository
knows. Before the install is reachable from anywhere else, put your own values
in a `.env` file beside the compose file:

```ini
SESSION_SECRET=<32 or more random characters>
POSTGRES_PASSWORD=<letters and digits, set before the first docker compose up>
```

Then put a proxy that terminates TLS in front of `127.0.0.1:4100`. With Caddy,
the whole of it is:

```text
analytics.example.com {
	reverse_proxy 127.0.0.1:4100
}
```

`POSTGRES_PASSWORD` is written into the database the first time it starts; to
change it later, change the role's password in the database as well. To
publish the server on every address instead of behind a proxy, set
`CHOKH_PUBLISH=0.0.0.0:4100`.

## Visitors' addresses behind a proxy

Behind your proxy, every request arrives from the proxy. Tell Chokh which
proxy to believe about who the visitor is:

```ini
TRUST_PROXY=127.0.0.1/32
```

Behind Cloudflare, set `TRUST_PROXY` to Cloudflare's address ranges and
`REAL_IP_HEADER=CF-Connecting-IP`, or every visitor is at Cloudflare's
address. To serve the tracker from the site's own domain instead, see
[a first-party path](/first-party/).

## Where visitors are

Country, region and city come from a database on the server, which the
server downloads itself and replaces when it is a month old. No visitor's
address is sent anywhere to look it up.
With no settings it uses DB-IP Lite City, which needs no account. With a free
MaxMind licence key in `GEOIP_LICENSE_KEY` it uses GeoLite2-City. Until the
first download finishes, visits are counted without a place.

## More than one process

One process keeps who is online, the realtime nudge and the record of used
single sign-on tokens in memory. Run more than one and they need
`REDIS_URL`, which both compose files already set.

## How long data is kept

Each site keeps its raw visits and events for as long as its retention
setting says: 180 days unless you change it, and anything from 1 to 3650 days,
with no licence key. Older days stay in the reports as daily totals.

## Upgrades

```bash
git pull
docker compose up -d --build
```

On PostgreSQL the compose file runs the migration before the server starts,
every time. On MongoDB, run the migration command from
[Start it](#start-it) again after each upgrade.

## Backups

The rows are in the database's volume. Back the database up with its own
tools, on a schedule of your own:

```bash PostgreSQL
docker compose exec postgres pg_dump -U chokh chokh > chokh-backup.sql
```

```bash MongoDB
docker compose -f docker-compose.mongodb.yml exec mongo mongodump --db chokh --archive > chokh-backup.archive
```

Never run `docker compose down -v`: `-v` deletes the volumes, and the rows
with them.

## Logs

A log line holds a request's method, the host and the route it reached, and
never its query string, a token or the visitor's address. `LOG_LEVEL` sets
how much is written. Every setting is on the
[environment](/environment/) page.

## Moving from another tool

Plausible's CSV export, Umami's data export and GA4 reports can be brought in
as daily history with one command; the
[README](https://github.com/chokh-analytics/chokh#importing-history) says how.
