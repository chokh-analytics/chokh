---
title: Chokh
lead: Open source, first-party web analytics you host yourself. One process carries the whole product: a tracker script under 3 KB, a collector, a stats API, a realtime stream and a dashboard.
description: Chokh is open source, first-party web analytics you host yourself: a tracker under 3 KB, a collector, a stats API and a dashboard in one process.
---

Chokh (চোখ, "eye") counts the people who visit your site on a server you run,
and keeps what it counts there. By default it sets no cookie and stores no full
address; a site that signs people in can choose a persistent visitor id and
full addresses instead, as settings of that site.

## Run it

Docker Compose starts the dashboard and the collector on
`http://localhost:4100`, with the database beside them and its tables made.
PostgreSQL is the default; MongoDB is the other supported database, with its
own compose file and one command to create its indexes.

```bash PostgreSQL
git clone https://github.com/chokh-analytics/chokh.git
cd chokh
docker compose up
```

```bash MongoDB
git clone https://github.com/chokh-analytics/chokh.git
cd chokh
docker compose -f docker-compose.mongodb.yml up -d
docker compose -f docker-compose.mongodb.yml exec server node packages/store-mongo/dist/migrate.js --apply
```

Then register the first account, which owns the install, and create a site:

```bash
curl -c jar -X POST localhost:4100/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password"}'

curl -b jar -X POST localhost:4100/api/sites \
  -H 'content-type: application/json' \
  -d '{"id":"my_site","name":"My site","domains":["example.com"],"settings":{"timezone":"UTC"}}'
```

## Count a site

Put the script on every page you want counted, with your site's id and the
address your install answers on:

```html
<script defer data-site="my_site" src="https://analytics.example.com/a.js"></script>
```

## What it gives you

- Visitors, visits, pageviews, bounce and visit duration, each with a
  comparison to the period before.
- Pages, entry and exit pages, time on page and scroll depth; referrers,
  channels and UTM campaigns; country, region and city from an offline
  database; browser, system and device.
- Who is on the site right now, and which page they are on.
- Events, goals, funnels, the paths visits took, retention cohorts, and people
  you identify by your own id.
- Web vitals and JavaScript errors.
- A JSON API for all of it, a CSV export, and a live stream.

## Free, and what is paid

The core is MIT licensed and free to host in full, with no key and no limit on
what it measures. A few features for larger teams live in `packages/ee` under
a commercial licence and run only with a licence key; an install without one
is still complete. [What is in each half](/licence/).
