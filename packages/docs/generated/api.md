---
title: API reference
lead: Every route of the server, who may call it, what it takes, and what it answered on an invented site.
description: The Chokh HTTP API, route by route, generated from the server's own route table and schemas.
---

This page is generated from the server's route table, its schemas and
`route-docs.ts` in `packages/server` and `packages/ee`, and every example
is the answer the real server gave. The same is in [openapi.json](/openapi.json)
for your own tools.

## How to call it

Every answer is JSON in one envelope: `{ "success": true, "data": ..., "meta": ... }`,
or `{ "success": false, "error": { "code", "message", "details" } }` with
the status that fits. A route that changes something is sent JSON.

A caller is somebody signed in, with the `chokh_session` cookie that
signing in sets, or a key, sent as `Authorization: Bearer <token>`. A key
carries scopes on one site: `read:stats` reads reports, `read:identity`
also reads who people are, `write:events` sends events from a server, and
`admin` changes the site. A route marked Chokh Pro answers only on an
install whose licence key names its feature.

Times are Unix milliseconds. A report's `from` and `to` also take a date
and time written as ISO 8601.

**About the examples.** They come from Saltwind Coffee, a site invented for
these pages, recorded from the server at noon UTC on 1 October 2026. An id
the server made at random is shown as `g_example1` and so on, and every
list is cut to its first three items. Routes of Chokh Pro, a redirect, the
realtime stream, the badge picture and the check a load balancer reads have
no recorded example.

## Collecting

### POST /api/collect

What the tracker sends: a batch of pageviews and events from one page, read as JSON whatever its content type says.

**Who:** Anybody.

**Body:**

- `siteId`, text, required
- `sentAt`, a whole number, required
- `hostname`, text, required
- `lang`, text
- `screen`, text
- `viewport`, text
- `visitorId`, text
- `userId`, text
- `sig`, text
- `events`, a list of an object, required

### POST /api/sites/:siteId/events

Events and identifies from your own server, with a key carrying write:events.

**Who:** A session or a key with `write:events` on the site.

**Body:**

- `userId`, text, required
- `visitorId`, text
- `events`, a list of an object, required

### GET /health

Whether the process is up, for a load balancer or a container check.

**Who:** Anybody.

## Signing in

### POST /api/auth/register

The first account of an install registers itself and owns it; after that, an owner creates accounts.

**Who:** Anybody, for the first account of an install; after that, a person who owns a team.

**Body:**

- `email`, text, required
- `password`, text, required
- `name`, text

### POST /api/auth/login

Signs in with an address and a password and sets the session cookie.

**Who:** Anybody.

**Body:**

- `email`, text, required
- `password`, text, required

### POST /api/auth/logout

Ends the session this request carries.

**Who:** Anybody signed in, or any key.

### POST /api/sso

Exchanges a token another application signed for a session, for that application's server.

**Who:** Anybody.

**Body:**

- `token`, text, required

### GET /api/sso

The same exchange for a person following a link: sets the cookie and redirects to `next`.

**Who:** Anybody.

**Query:**

- `token`, text, required
- `next`, text

### GET /api/me

Who is asking: the account or the key, and every site it can read with its role and scopes.

**Who:** Anybody signed in, or any key.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "actor": {
      "kind": "session",
      "id": "u_example1"
    },
    "user": {
      "id": "u_example1",
      "email": "owner@saltwind.example",
      "name": "Ayla Moreno"
    },
    "sites": [
      {
        "id": "s_saltwind",
        "name": "Saltwind Coffee",
        "domains": [
          "saltwind.example"
        ],
        "teamId": "default",
        "settings": {
          "ipMode": "anonymized",
          "visitorIdMode": "cookieless",
          "botFilter": true,
          "retentionDays": 180,
          "timezone": "UTC",
          "allowUnsignedIdentify": true,
          "excludeIps": [],
          "excludePaths": [],
          "excludeQueryParams": [],
          "routeGroups": [],
          "errorCapture": false,
          "errorStacks": false
        },
        "share": {
          "token": "share_example1",
          "protected": false,
          "createdAt": 1790856000000
        },
        "scopes": [
          "admin",
          "read:identity",
          "read:stats"
        ],
        "role": "owner"
      }
    ],
    "teams": [
      {
        "id": "default",
        "name": "Default",
        "role": "owner"
      }
    ]
  }
}
```

### GET /api/license

What this install may run: the licence's holder, its features and its expiry, or that there is none.

**Who:** Anybody signed in, or any key.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "licensed": false,
    "plan": null,
    "licensee": null,
    "expiresAt": null,
    "features": []
  }
}
```

## Sites

### GET /api/sites

The sites the caller can read.

**Who:** Anybody signed in, or any key.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "sites": [
      {
        "id": "s_saltwind",
        "name": "Saltwind Coffee",
        "domains": [
          "saltwind.example"
        ],
        "teamId": "default",
        "settings": {
          "ipMode": "anonymized",
          "visitorIdMode": "cookieless",
          "botFilter": true,
          "retentionDays": 180,
          "timezone": "UTC",
          "allowUnsignedIdentify": true,
          "excludeIps": [],
          "excludePaths": [],
          "excludeQueryParams": [],
          "routeGroups": [],
          "errorCapture": false,
          "errorStacks": false
        },
        "share": {
          "token": "share_example1",
          "protected": false,
          "createdAt": 1790856000000
        },
        "scopes": [
          "admin",
          "read:identity",
          "read:stats"
        ],
        "role": "owner"
      }
    ]
  }
}
```

### POST /api/sites

Creates a site, with its id, name, domains and settings. Its identify secret is in the answer, once.

**Who:** A person signed in who owns the team. Never a key.

**Body:**

- `id`, text
- `name`, text, required
- `domains`, a list of text, required
- `teamId`, text
- `settings`, an object

### GET /api/sites/:siteId

One site and its settings.

**Who:** A session or a key with `read:stats` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "site": {
      "id": "s_saltwind",
      "name": "Saltwind Coffee",
      "domains": [
        "saltwind.example"
      ],
      "teamId": "default",
      "settings": {
        "ipMode": "anonymized",
        "visitorIdMode": "cookieless",
        "botFilter": true,
        "retentionDays": 180,
        "timezone": "UTC",
        "allowUnsignedIdentify": true,
        "excludeIps": [],
        "excludePaths": [],
        "excludeQueryParams": [],
        "routeGroups": [],
        "errorCapture": false,
        "errorStacks": false
      },
      "share": {
        "token": "share_example1",
        "protected": false,
        "createdAt": 1790856000000
      }
    },
    "scopes": [
      "admin",
      "read:identity",
      "read:stats"
    ],
    "role": "owner"
  }
}
```

### PATCH /api/sites/:siteId

Changes a site's name, domains or settings.

**Who:** A session or a key with `admin` on the site.

**Body:**

- `name`, text
- `domains`, a list of text
- `settings`, an object

### POST /api/sites/:siteId/identify-secret/rotate

Replaces the site's identify secret; the new one is in the answer, once.

**Who:** A session or a key with `admin` on the site.

## Keys

### GET /api/sites/:siteId/keys

The site's keys, without their tokens.

**Who:** A session or a key with `admin` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "keys": [
      {
        "id": "k_example1",
        "siteId": "s_saltwind",
        "name": "Checkout server",
        "scopes": [
          "write:events"
        ],
        "createdAt": 1790856000000,
        "createdBy": "u_example1"
      }
    ]
  }
}
```

### POST /api/sites/:siteId/keys

Creates a key with the scopes named; its token is in the answer, once.

**Who:** A session or a key with `admin` on the site.

**Body:**

- `name`, text, required
- `scopes`, a list of one of `read:stats`, `read:identity`, `write:events`, `admin`, required

### DELETE /api/sites/:siteId/keys/:keyId

Revokes a key.

**Who:** A session or a key with `admin` on the site.

## Reports

### GET /api/sites/:siteId/stats/aggregate

The headline numbers for a range: visitors, visits, pageviews, bounce rate, visit duration, with a comparison when asked.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "range": {
      "from": 1790251200000,
      "to": 1790856000000
    },
    "previousRange": null,
    "metrics": {
      "visitors": 6,
      "pageviews": 13,
      "visits": 6,
      "bounces": 1,
      "bounceRate": 0.16666666666666666,
      "avgDurationMs": 60000
    },
    "previous": null
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000
  }
}
```

### GET /api/sites/:siteId/stats/timeseries

The same numbers by minute, hour, day, week or month.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "interval": "day",
    "points": [
      {
        "start": 1790208000000,
        "end": 1790294400000,
        "metrics": {
          "visitors": 0,
          "pageviews": 0,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      },
      {
        "start": 1790294400000,
        "end": 1790380800000,
        "metrics": {
          "visitors": 0,
          "pageviews": 0,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      },
      {
        "start": 1790380800000,
        "end": 1790467200000,
        "metrics": {
          "visitors": 0,
          "pageviews": 0,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      }
    ],
    "previous": null
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000
  }
}
```

### GET /api/sites/:siteId/stats/breakdown

One dimension's rows (pages, sources, countries, devices and the rest), with their numbers.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "dim": "page",
    "rows": [
      {
        "key": "/",
        "metrics": {
          "visitors": 4,
          "pageviews": 4,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      },
      {
        "key": "/menu",
        "metrics": {
          "visitors": 3,
          "pageviews": 3,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      },
      {
        "key": "/shop/beans",
        "metrics": {
          "visitors": 3,
          "pageviews": 3,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      }
    ]
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000
  }
}
```

### GET /api/sites/:siteId/stats/engagement

Time on page and scroll depth by page.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "dim": "page",
    "rows": [],
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180
  }
}
```

### GET /api/sites/:siteId/export.csv

Any report as a CSV file.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```text
key,visitors,pageviews,visits,bounces,bounce_rate,avg_duration_ms
/,4,4,0,0,,
/menu,3,3,0,0,,
/shop/beans,3,3,0,0,,
/shop/checkout,2,2,0,0,,
/about,1,1,0,0,,
```

### GET /api/sites/:siteId/stats/events

Custom events and how often each happened.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "visitors": 6,
    "rows": [
      {
        "key": "order_paid",
        "visitors": 2,
        "events": 2,
        "rate": 0.3333333333333333
      }
    ],
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "rawOnly": true
  }
}
```

### GET /api/sites/:siteId/stats/properties

One event's properties and their values.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text
- `event`, text, required
- `property`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "event": "order_paid",
    "properties": [
      {
        "key": "size",
        "events": 2
      }
    ],
    "property": "size",
    "visitors": 6,
    "rows": [
      {
        "key": "250g",
        "visitors": 2,
        "events": 2,
        "rate": 0.3333333333333333
      }
    ],
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "rawOnly": true
  }
}
```

### GET /api/sites/:siteId/stats/goals

Each goal's conversions and conversion rate.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "visitors": 6,
    "rows": [
      {
        "goal": {
          "siteId": "s_saltwind",
          "id": "g_example1",
          "name": "Order paid",
          "kind": "event",
          "match": "order_paid",
          "createdBy": "u_example1",
          "createdAt": 1790856000000
        },
        "conversion": {
          "visitors": 2,
          "completions": 2,
          "rate": 0.3333333333333333,
          "value": null
        }
      },
      {
        "goal": {
          "siteId": "s_saltwind",
          "id": "g_example2",
          "name": "Saw the menu",
          "kind": "page",
          "match": "/menu",
          "createdBy": "u_example1",
          "createdAt": 1790856000000
        },
        "conversion": {
          "visitors": 3,
          "completions": 3,
          "rate": 0.5,
          "value": null
        }
      }
    ],
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "rawOnly": true
  }
}
```

### GET /api/sites/:siteId/stats/funnel

A saved funnel: how many reached each step, and where they dropped off.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text
- `funnel`, text, required

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "funnel": {
      "siteId": "s_saltwind",
      "id": "f_example1",
      "name": "Home to checkout",
      "steps": [
        {
          "kind": "page",
          "match": "/",
          "name": "/"
        },
        {
          "kind": "page",
          "match": "/shop/beans",
          "name": "/shop/beans"
        },
        {
          "kind": "page",
          "match": "/shop/checkout",
          "name": "/shop/checkout"
        }
      ],
      "window": "visit",
      "createdBy": "u_example1",
      "createdAt": 1790856000000
    },
    "visitors": 6,
    "steps": [
      {
        "visitors": 4,
        "dropOff": 0,
        "rate": 1,
        "stepRate": null
      },
      {
        "visitors": 2,
        "dropOff": 2,
        "rate": 0.5,
        "stepRate": 0.5
      },
      {
        "visitors": 1,
        "dropOff": 1,
        "rate": 0.25,
        "stepRate": 0.5
      }
    ],
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "rawOnly": true,
    "funnel": "f_example1"
  }
}
```

### GET /api/sites/:siteId/stats/journeys

The paths visits took from the page they came in on.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text
- `branches`, a whole number

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "visits": 6,
    "columns": [
      [
        {
          "key": "/",
          "visits": 4,
          "exits": 0,
          "onward": 0
        },
        {
          "key": "/menu",
          "visits": 1,
          "exits": 1,
          "onward": 0
        },
        {
          "key": "/shop/beans",
          "visits": 1,
          "exits": 0,
          "onward": 0
        }
      ],
      [
        {
          "key": "/menu",
          "visits": 2,
          "exits": 1,
          "onward": 0
        },
        {
          "key": "/about",
          "visits": 1,
          "exits": 1,
          "onward": 0
        },
        {
          "key": "/shop/beans",
          "visits": 1,
          "exits": 0,
          "onward": 0
        }
      ],
      [
        {
          "key": "/shop/beans",
          "visits": 1,
          "exits": 1,
          "onward": 0
        },
        {
          "key": "/shop/checkout",
          "visits": 1,
          "exits": 1,
          "onward": 0
        }
      ]
    ],
    "links": [
      {
        "column": 0,
        "from": "/",
        "to": "/menu",
        "visits": 2
      },
      {
        "column": 0,
        "from": "/",
        "to": "/about",
        "visits": 1
      },
      {
        "column": 0,
        "from": "/",
        "to": "/shop/beans",
        "visits": 1
      }
    ],
    "branches": 5,
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "rawOnly": true
  }
}
```

### GET /api/sites/:siteId/stats/cohorts

Retention cohorts: of the visitors first seen in a week or month, how many came back in each one after.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `interval`, one of `week`, `month`

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "interval": "week",
    "cohorts": [
      {
        "start": 1789948800000,
        "end": 1790553600000,
        "visitors": 0,
        "periods": [
          {
            "start": 1789948800000,
            "end": 1790553600000,
            "visitors": 0,
            "rate": null,
            "complete": true
          },
          {
            "start": 1790553600000,
            "end": 1791158400000,
            "visitors": 0,
            "rate": null,
            "complete": false
          }
        ]
      },
      {
        "start": 1790553600000,
        "end": 1791158400000,
        "visitors": 6,
        "periods": [
          {
            "start": 1790553600000,
            "end": 1791158400000,
            "visitors": 6,
            "rate": 1,
            "complete": false
          }
        ]
      }
    ],
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "visitorIdMode": "cookieless",
    "rawOnly": true,
    "interval": "week"
  }
}
```

### GET /api/sites/:siteId/stats/activity

Daily, weekly and monthly active visitors, and stickiness.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "days": [
      {
        "start": 1790208000000,
        "end": 1790294400000,
        "dau": 0,
        "wau": 0,
        "mau": 0,
        "complete": true
      },
      {
        "start": 1790294400000,
        "end": 1790380800000,
        "dau": 0,
        "wau": 0,
        "mau": 0,
        "complete": true
      },
      {
        "start": 1790380800000,
        "end": 1790467200000,
        "dau": 0,
        "wau": 0,
        "mau": 0,
        "complete": true
      }
    ],
    "dau": 0,
    "wau": 0,
    "mau": 0,
    "stickiness": null,
    "visitors": 6,
    "returning": 0,
    "returningRate": 0,
    "curve": [
      6,
      0,
      0
    ],
    "powerMinDays": 3,
    "powerUsers": 0,
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "visitorIdMode": "cookieless",
    "rawOnly": true
  }
}
```

### GET /api/sites/:siteId/stats/attribution

First touch against last touch for one goal: what first brought each converting visitor, and what brought the visit they converted in.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `goal`, text, required
- `dim`, one of `channel`, `referrer`, `utm_source`, `utm_medium`, `utm_campaign`, `entry`

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "dim": "channel",
    "visitors": 2,
    "completions": 2,
    "value": null,
    "rows": [
      {
        "key": "direct",
        "first": {
          "visitors": 1,
          "completions": 1
        },
        "last": {
          "visitors": 1,
          "completions": 1
        }
      },
      {
        "key": "organic",
        "first": {
          "visitors": 1,
          "completions": 1
        },
        "last": {
          "visitors": 1,
          "completions": 1
        }
      }
    ],
    "other": {
      "first": {
        "visitors": 0,
        "completions": 0
      },
      "last": {
        "visitors": 0,
        "completions": 0
      }
    },
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "visitorIdMode": "cookieless",
    "rawOnly": true,
    "goal": "g_example1",
    "dim": "channel"
  }
}
```

### GET /api/sites/:siteId/stats/power-users

The most active people of the range, as rows of the people directory; their names only for a caller with read:identity.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `limit`, a whole number
- `minDays`, a whole number

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "people": [],
    "days": 8,
    "minDays": 3,
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "visitorIdMode": "cookieless",
    "rawOnly": true,
    "identity": true,
    "limit": 20
  }
}
```

### GET /api/sites/:siteId/stats/vitals

Core Web Vitals by page, at the 75th percentile.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `device`, one of `desktop`, `mobile`, `tablet`
- `sort`, one of `LCP`, `INP`, `CLS`, `FCP`, `TTFB`

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "minSamples": 20,
    "sort": "LCP",
    "metrics": [
      {
        "metric": "LCP",
        "p75": null,
        "samples": 0,
        "rating": null,
        "shares": null,
        "devices": []
      },
      {
        "metric": "INP",
        "p75": null,
        "samples": 0,
        "rating": null,
        "shares": null,
        "devices": []
      },
      {
        "metric": "CLS",
        "p75": null,
        "samples": 0,
        "rating": null,
        "shares": null,
        "devices": []
      }
    ],
    "pages": [],
    "pagesTotal": 0,
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "visitorIdMode": "cookieless",
    "rawOnly": true,
    "sort": "LCP",
    "device": null
  }
}
```

### GET /api/sites/:siteId/stats/errors

JavaScript errors, grouped by message and place.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required
- `limit`, a whole number

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "total": 0,
    "visitors": 0,
    "groups": [],
    "groupsTotal": 0,
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "visitorIdMode": "cookieless",
    "rawOnly": true,
    "limit": 50,
    "errorCapture": false,
    "errorStacks": false
  }
}
```

### GET /api/sites/:siteId/stats/coverage

Of the people the site's server named, the share no browser row carries: an estimate of how many block or decline the tracker.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, text, required
- `to`, text, required

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "state": "no_server_events",
    "people": 0,
    "seenInBrowser": 0,
    "serverOnly": 0,
    "share": null,
    "browserIdentified": 0,
    "minPeople": 20,
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "visitorIdMode": "cookieless",
    "rawOnly": true
  }
}
```

## Realtime

### GET /api/sites/:siteId/realtime

Who is on the site now, and on which page.

**Who:** A session or a key with `read:stats` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "online": 0,
    "signedIn": 0,
    "anonymous": 0,
    "byPage": [],
    "byCountry": [],
    "byCity": [],
    "visitors": [],
    "recent": [
      {
        "visitorId": "v_example1",
        "since": 1790855880000,
        "lastSeenAt": 1790855880000,
        "path": "/menu",
        "browser": "Mobile Safari",
        "os": "iOS",
        "device": "mobile",
        "ip": "203.0.113.0"
      }
    ]
  },
  "meta": {
    "siteId": "s_saltwind",
    "identity": true
  }
}
```

### GET /api/sites/:siteId/realtime/stream

The same, pushed as server-sent events when it changes.

**Who:** A session or a key with `read:stats` on the site.

## People

### GET /api/sites/:siteId/people

Everybody the site has seen, with search and an identified-only switch.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `limit`, a whole number
- `cursor`, text
- `identifiedOnly`, one of `true`, `false`
- `q`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "people": [
      {
        "visitorId": "u:cust_1042",
        "firstSeenAt": 1790856000000,
        "lastSeenAt": 1790856000000,
        "sessions": 1,
        "pageviews": 0,
        "devices": [],
        "ips": [],
        "userId": "cust_1042",
        "traits": {
          "plan": "subscriber"
        }
      },
      {
        "visitorId": "v_example1",
        "firstSeenAt": 1790855880000,
        "lastSeenAt": 1790855880000,
        "sessions": 1,
        "pageviews": 1,
        "devices": [
          "Mobile Safari on iOS"
        ],
        "ips": [
          "203.0.113.0"
        ],
        "homeGeo": {}
      },
      {
        "visitorId": "v_example2",
        "firstSeenAt": 1790834400000,
        "lastSeenAt": 1790834520000,
        "sessions": 1,
        "pageviews": 3,
        "devices": [
          "Chrome on Windows"
        ],
        "ips": [
          "203.0.113.0"
        ],
        "homeGeo": {}
      }
    ],
    "next": null
  },
  "meta": {
    "identity": true,
    "limit": 50
  }
}
```

### GET /api/sites/:siteId/visitors/:visitorId

One visitor's visits and events.

**Who:** A session or a key with `read:stats` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "siteId": "s_saltwind",
    "visitorId": "u:cust_1042",
    "firstSeenAt": 1790856000000,
    "lastSeenAt": 1790856000000,
    "pageviews": 0,
    "events": 1,
    "sessions": 1,
    "devices": [],
    "ips": [],
    "timeline": [
      {
        "ts": 1790856000000,
        "type": "event",
        "name": "order_paid",
        "sessionId": "VxiLqkfaYyOp9wtV-wmJ7N"
      },
      {
        "ts": 1790856000000,
        "type": "identify",
        "sessionId": "VxiLqkfaYyOp9wtV-wmJ7N"
      }
    ],
    "userId": "cust_1042",
    "traits": {
      "plan": "subscriber"
    },
    "firstTouch": {
      "at": 1790856000000,
      "channel": "direct"
    },
    "lastTouch": {
      "at": 1790856000000,
      "channel": "direct"
    }
  },
  "meta": {
    "identity": true
  }
}
```

### GET /api/sites/:siteId/users/:userId

One identified person's visits, events and traits.

**Who:** A session or a key with `read:identity` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "siteId": "s_saltwind",
    "visitorIds": [
      "u:cust_1042"
    ],
    "firstSeenAt": 1790856000000,
    "lastSeenAt": 1790856000000,
    "pageviews": 0,
    "events": 1,
    "sessions": 1,
    "devices": [],
    "ips": [],
    "timeline": [
      {
        "ts": 1790856000000,
        "type": "event",
        "name": "order_paid",
        "sessionId": "VxiLqkfaYyOp9wtV-wmJ7N"
      },
      {
        "ts": 1790856000000,
        "type": "identify",
        "sessionId": "VxiLqkfaYyOp9wtV-wmJ7N"
      }
    ],
    "userId": "cust_1042",
    "traits": {
      "plan": "subscriber"
    },
    "firstTouch": {
      "at": 1790856000000,
      "channel": "direct"
    },
    "lastTouch": {
      "at": 1790856000000,
      "channel": "direct"
    }
  }
}
```

### GET /api/sites/:siteId/users/:userId/presence

Whether that person is on the site now.

**Who:** A session or a key with `read:identity` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "online": false,
    "lastSeenAt": 1790856000000
  }
}
```

## Goals, funnels, segments and annotations

### GET /api/sites/:siteId/goals

The site's goals.

**Who:** A session or a key with `read:stats` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "goals": [
      {
        "siteId": "s_saltwind",
        "id": "g_example1",
        "name": "Order paid",
        "kind": "event",
        "match": "order_paid",
        "createdBy": "u_example1",
        "createdAt": 1790856000000
      },
      {
        "siteId": "s_saltwind",
        "id": "g_example2",
        "name": "Saw the menu",
        "kind": "page",
        "match": "/menu",
        "createdBy": "u_example1",
        "createdAt": 1790856000000
      }
    ]
  },
  "meta": {
    "siteId": "s_saltwind",
    "max": 50
  }
}
```

### POST /api/sites/:siteId/goals

Creates a goal: a page or an event.

**Who:** A session or a key with `admin` on the site.

**Body:**

One of these shapes:

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "page"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "match": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        },
        "value": {
          "type": "number",
          "minimum": 0,
          "maximum": 1000000000
        }
      },
      "required": [
        "kind",
        "name",
        "match"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "event"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "match": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "value": {
          "type": "number",
          "minimum": 0,
          "maximum": 1000000000
        }
      },
      "required": [
        "kind",
        "name",
        "match"
      ],
      "additionalProperties": false
    }
  ]
}
```

### DELETE /api/sites/:siteId/goals/:goalId

Deletes a goal.

**Who:** A session or a key with `admin` on the site.

### GET /api/sites/:siteId/funnels

The site's funnels.

**Who:** A session or a key with `read:stats` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "funnels": [
      {
        "siteId": "s_saltwind",
        "id": "f_example1",
        "name": "Home to checkout",
        "steps": [
          {
            "kind": "page",
            "match": "/",
            "name": "/"
          },
          {
            "kind": "page",
            "match": "/shop/beans",
            "name": "/shop/beans"
          },
          {
            "kind": "page",
            "match": "/shop/checkout",
            "name": "/shop/checkout"
          }
        ],
        "window": "visit",
        "createdBy": "u_example1",
        "createdAt": 1790856000000
      }
    ]
  },
  "meta": {
    "siteId": "s_saltwind",
    "max": 50,
    "maxSteps": 8,
    "windows": [
      "visit",
      "1h",
      "1d"
    ],
    "defaultWindow": "visit"
  }
}
```

### POST /api/sites/:siteId/funnels

Creates a funnel from its steps.

**Who:** A session or a key with `admin` on the site.

**Body:**

- `name`, text, required
- `window`, one of `visit`, `1h`, `1d`, `7d`, `30d`
- `steps`, a list of an object, required

### DELETE /api/sites/:siteId/funnels/:funnelId

Deletes a funnel.

**Who:** A session or a key with `admin` on the site.

### GET /api/sites/:siteId/segments

The site's saved segments.

**Who:** A session or a key with `read:stats` on the site.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "segments": [
      {
        "siteId": "s_saltwind",
        "id": "sg_example1",
        "name": "From Google",
        "filters": [
          {
            "dim": "referrer",
            "op": "contains",
            "value": "google"
          }
        ],
        "createdBy": "u_example1",
        "createdAt": 1790856000000
      }
    ]
  },
  "meta": {
    "siteId": "s_saltwind",
    "max": 50
  }
}
```

### POST /api/sites/:siteId/segments

Saves a list of filters under a name.

**Who:** A session or a key with `admin` on the site.

**Body:**

- `name`, text, required
- `filters`, a list of an object, required

### DELETE /api/sites/:siteId/segments/:segmentId

Deletes a segment.

**Who:** A session or a key with `admin` on the site.

### GET /api/sites/:siteId/annotations

The marks drawn on the chart in a range.

**Who:** A session or a key with `read:stats` on the site.

**Query:**

- `from`, a whole number, required
- `to`, a whole number, required

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "annotations": [
      {
        "siteId": "s_saltwind",
        "id": "an_example1",
        "at": 1790510400000,
        "kind": "campaign",
        "text": "Autumn blend launched",
        "createdBy": "u_example1",
        "createdAt": 1790856000000
      }
    ]
  },
  "meta": {
    "siteId": "s_saltwind",
    "from": 1790251200000,
    "to": 1790856000000,
    "max": 1000
  }
}
```

### POST /api/sites/:siteId/annotations

Adds a mark: a deploy, a campaign, an outage or a note.

**Who:** A session or a key with `write:events` on the site.

**Body:**

- `at`, a whole number, required
- `kind`, one of `deploy`, `campaign`, `downtime`, `note`, required
- `text`, text, required
- `url`, text

### DELETE /api/sites/:siteId/annotations/:annotationId

Deletes a mark.

**Who:** A session or a key with `write:events` on the site.

## Sharing

### PUT /api/sites/:siteId/share

Turns on the public share link, with an optional password, or changes it.

**Who:** A session or a key with `admin` on the site.

**Body:**

- `regenerate`, true or false
- `password`, text

### DELETE /api/sites/:siteId/share

Turns the share link off.

**Who:** A session or a key with `admin` on the site.

### GET /api/share/:token

What a share link shows: the site's name and whether a password is asked for.

**Who:** Anybody.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "site": {
      "name": "Saltwind Coffee",
      "timezone": "UTC"
    },
    "protected": false,
    "unlocked": true
  }
}
```

### POST /api/share/:token/unlock

Opens a share that has a password.

**Who:** Anybody.

**Body:**

- `password`, text, required

### GET /api/share/:token/stats/aggregate

The headline numbers, through a share link.

**Who:** Whoever holds the share link, and its password when it has one.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "range": {
      "from": 1790251200000,
      "to": 1790856000000
    },
    "previousRange": null,
    "metrics": {
      "visitors": 6,
      "pageviews": 13,
      "visits": 6,
      "bounces": 1,
      "bounceRate": 0.16666666666666666,
      "avgDurationMs": 60000
    },
    "previous": null
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000
  }
}
```

### GET /api/share/:token/stats/timeseries

The chart, through a share link.

**Who:** Whoever holds the share link, and its password when it has one.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "interval": "day",
    "points": [
      {
        "start": 1790208000000,
        "end": 1790294400000,
        "metrics": {
          "visitors": 0,
          "pageviews": 0,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      },
      {
        "start": 1790294400000,
        "end": 1790380800000,
        "metrics": {
          "visitors": 0,
          "pageviews": 0,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      },
      {
        "start": 1790380800000,
        "end": 1790467200000,
        "metrics": {
          "visitors": 0,
          "pageviews": 0,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      }
    ],
    "previous": null
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000
  }
}
```

### GET /api/share/:token/stats/breakdown

One dimension's rows, through a share link.

**Who:** Whoever holds the share link, and its password when it has one.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "dim": "page",
    "rows": [
      {
        "key": "/",
        "metrics": {
          "visitors": 4,
          "pageviews": 4,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      },
      {
        "key": "/menu",
        "metrics": {
          "visitors": 3,
          "pageviews": 3,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      },
      {
        "key": "/shop/beans",
        "metrics": {
          "visitors": 3,
          "pageviews": 3,
          "visits": 0,
          "bounces": 0,
          "bounceRate": null,
          "avgDurationMs": null
        }
      }
    ]
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000
  }
}
```

### GET /api/share/:token/stats/goals

The goals, through a share link.

**Who:** Whoever holds the share link, and its password when it has one.

**Query:**

- `from`, text, required
- `to`, text, required
- `filters`, text
- `compare`, one of `previous_period`, `previous_year`
- `interval`, one of `minute`, `hour`, `day`, `week`, `month`
- `dim`, one of `page`, `route`, `entry`, `exit`, `referrer`, `channel`, `utm_source`, `utm_medium` and more
- `metrics`, text
- `limit`, a whole number
- `goal`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "visitors": 6,
    "rows": [
      {
        "goal": {
          "siteId": "s_saltwind",
          "id": "g_example1",
          "name": "Order paid",
          "kind": "event",
          "match": "order_paid",
          "createdBy": "u_example1",
          "createdAt": 1790856000000
        },
        "conversion": {
          "visitors": 2,
          "completions": 2,
          "rate": 0.3333333333333333,
          "value": null
        }
      },
      {
        "goal": {
          "siteId": "s_saltwind",
          "id": "g_example2",
          "name": "Saw the menu",
          "kind": "page",
          "match": "/menu",
          "createdBy": "u_example1",
          "createdAt": 1790856000000
        },
        "conversion": {
          "visitors": 3,
          "completions": 3,
          "rate": 0.5,
          "value": null
        }
      }
    ],
    "rawOnly": true
  },
  "meta": {
    "siteId": "s_saltwind",
    "timezone": "UTC",
    "from": 1790251200000,
    "to": 1790856000000,
    "retentionDays": 180,
    "rawOnly": true
  }
}
```

### GET /api/share/:token/annotations

The chart's marks, through a share link.

**Who:** Whoever holds the share link, and its password when it has one.

**Query:**

- `from`, a whole number, required
- `to`, a whole number, required

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "annotations": [
      {
        "siteId": "s_saltwind",
        "id": "an_example1",
        "at": 1790510400000,
        "kind": "campaign",
        "text": "Autumn blend launched",
        "createdBy": "u_example1",
        "createdAt": 1790856000000
      }
    ]
  },
  "meta": {
    "siteId": "s_saltwind",
    "from": 1790251200000,
    "to": 1790856000000,
    "max": 1000
  }
}
```

### GET /api/share/:token/widget.svg

A badge of visitors or pageviews for today, 7 or 30 days, to put on a page.

**Who:** Whoever holds the share link, and its password when it has one.

## Teams and members

### GET /api/teams/:teamId/members

A team's members and their roles.

**Who:** A person signed in who owns the team. Never a key.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "team": {
      "id": "default",
      "name": "Default"
    },
    "members": [
      {
        "userId": "u_example1",
        "email": "owner@saltwind.example",
        "name": "Ayla Moreno",
        "role": "owner",
        "identity": true,
        "managed": false
      }
    ]
  }
}
```

### PUT /api/teams/:teamId/members/:userId

Gives somebody a role in the team, or changes it.

**Who:** A person signed in who owns the team. Never a key.

**Body:**

- `role`, one of `owner`, `editor`, `viewer`, required
- `identity`, true or false
- `revokeKeys`, true or false

### DELETE /api/teams/:teamId/members/:userId

Removes somebody from the team.

**Who:** A person signed in who owns the team. Never a key.

**Query:**

- `revokeKeys`, one of `true`, `false`

### PATCH /api/teams/:teamId

Renames a team.

**Who:** A person signed in who owns the team. Never a key.

**Body:**

- `name`, text, required

### GET /api/sites/:siteId/members

Who has a role on this one site.

**Who:** A person signed in with `admin` on the site. Never a key.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "members": []
  },
  "meta": {
    "siteId": "s_saltwind"
  }
}
```

### PUT /api/sites/:siteId/members/:userId

Gives somebody a role on this one site, or changes it.

**Who:** A person signed in with `admin` on the site. Never a key.

**Body:**

- `role`, one of `owner`, `editor`, `viewer`, required
- `identity`, true or false
- `revokeKeys`, true or false

### DELETE /api/sites/:siteId/members/:userId

Removes somebody's role on this site.

**Who:** A person signed in with `admin` on the site. Never a key.

**Query:**

- `revokeKeys`, one of `true`, `false`

## Invitations

### GET /api/teams/:teamId/invitations

The team's invitations still waiting.

**Who:** A person signed in who owns the team. Never a key.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "invitations": []
  }
}
```

### POST /api/teams/:teamId/invitations

Invites somebody to the team; the link is in the answer, once.

**Who:** A person signed in who owns the team. Never a key.

**Body:**

- `email`, text, required
- `role`, one of `owner`, `editor`, `viewer`, required
- `identity`, true or false

### DELETE /api/teams/:teamId/invitations/:invitationId

Takes an invitation back.

**Who:** A person signed in who owns the team. Never a key.

### GET /api/sites/:siteId/invitations

The site's invitations still waiting.

**Who:** A person signed in with `admin` on the site. Never a key.

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "invitations": []
  },
  "meta": {
    "siteId": "s_saltwind"
  }
}
```

### POST /api/sites/:siteId/invitations

Invites somebody to this one site; the link is in the answer, once.

**Who:** A person signed in with `admin` on the site. Never a key.

**Body:**

- `email`, text, required
- `role`, one of `owner`, `editor`, `viewer`, required
- `identity`, true or false

### DELETE /api/sites/:siteId/invitations/:invitationId

Takes an invitation back.

**Who:** A person signed in with `admin` on the site. Never a key.

### POST /api/invitations/lookup

What an invitation is for, for the page its link opens.

**Who:** Anybody.

**Body:**

- `token`, text, required

### POST /api/invitations/accept

Uses an invitation: by the account signed in, or by a new one with a password.

**Who:** Anybody.

**Body:**

- `token`, text, required
- `password`, text
- `name`, text

## The audit log

### GET /api/teams/:teamId/audit

The team's log of who gave whom what, and who read identities, newest first.

**Who:** A person signed in who owns the team. Never a key.

**Query:**

- `limit`, a whole number
- `cursor`, text
- `from`, a whole number
- `to`, a whole number
- `actor`, text
- `kind`, one of `identity`, `access`, `log`
- `target`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "rows": [],
    "accounts": {},
    "next": null
  },
  "meta": {
    "identity": true,
    "limit": 5
  }
}
```

### GET /api/sites/:siteId/audit

The same log for one site.

**Who:** A session or a key with `admin` on the site.

**Query:**

- `limit`, a whole number
- `cursor`, text
- `from`, a whole number
- `to`, a whole number
- `actor`, text
- `kind`, one of `identity`, `access`, `log`
- `target`, text

**Answered 200:**

```json
{
  "success": true,
  "data": {
    "rows": [
      {
        "siteId": "s_saltwind",
        "ts": 1790856000000,
        "actor": {
          "kind": "session",
          "id": "u_example1",
          "email": "owner@saltwind.example"
        },
        "action": "read:identity",
        "route": "GET /api/sites/:siteId/users/:userId/presence",
        "fields": [
          "userId"
        ],
        "target": "cust_1042",
        "id": "5",
        "kind": "identity"
      },
      {
        "siteId": "s_saltwind",
        "ts": 1790856000000,
        "actor": {
          "kind": "session",
          "id": "u_example1",
          "email": "owner@saltwind.example"
        },
        "action": "read:identity",
        "route": "GET /api/sites/:siteId/users/:userId",
        "fields": [
          "traits",
          "userId"
        ],
        "target": "cust_1042",
        "id": "4",
        "kind": "identity"
      },
      {
        "siteId": "s_saltwind",
        "ts": 1790856000000,
        "actor": {
          "kind": "session",
          "id": "u_example1",
          "email": "owner@saltwind.example"
        },
        "action": "read:identity",
        "route": "GET /api/sites/:siteId/visitors/:visitorId",
        "fields": [
          "traits",
          "userId"
        ],
        "target": "u:cust_1042",
        "id": "3",
        "kind": "identity"
      }
    ],
    "accounts": {
      "u_example1": {
        "email": "owner@saltwind.example",
        "name": "Ayla Moreno"
      }
    },
    "next": "cursor_example1"
  },
  "meta": {
    "identity": true,
    "limit": 5
  }
}
```

## Alerts (Chokh Pro)

### GET /api/sites/:siteId/ee/alerts

The site's alerts and where each one sends.

**Who:** A session or a key with `read:stats` on the site.

**Chokh Pro:** the `alerts` feature.

### POST /api/sites/:siteId/ee/alerts

Creates an alert: a condition on a number, and the email, Telegram chat or webhook it goes to.

**Who:** A session or a key with `admin` on the site.

**Chokh Pro:** the `alerts` feature.

**Body:**

- `name`, text, required
- `condition`, an object, required
- `channels`, a list of an object, required

### DELETE /api/sites/:siteId/ee/alerts/:alertId

Deletes an alert.

**Who:** A session or a key with `admin` on the site.

**Chokh Pro:** the `alerts` feature.

### POST /api/sites/:siteId/ee/alerts/:alertId/test

Sends an alert's message now, to check where it goes.

**Who:** A session or a key with `admin` on the site.

**Chokh Pro:** the `alerts` feature.

## Digests (Chokh Pro)

### GET /api/sites/:siteId/ee/digests

The site's scheduled email digests.

**Who:** A session or a key with `read:stats` on the site.

**Chokh Pro:** the `digests` feature.

### POST /api/sites/:siteId/ee/digests

Schedules a digest by email, daily or weekly, with the same numbers in an attached PDF.

**Who:** A session or a key with `admin` on the site.

**Chokh Pro:** the `digests` feature.

**Body:**

- `cadence`, one of `daily`, `weekly`, required
- `to`, a list of text, required
- `hour`, a whole number
- `weekday`, a whole number

### DELETE /api/sites/:siteId/ee/digests/:digestId

Stops a digest.

**Who:** A session or a key with `admin` on the site.

**Chokh Pro:** the `digests` feature.

### POST /api/sites/:siteId/ee/digests/:digestId/send

Sends a digest now.

**Who:** A session or a key with `admin` on the site.

**Chokh Pro:** the `digests` feature.

## More than one team (Chokh Pro)

### POST /api/ee/teams

Creates a team, owned by whoever creates it.

**Who:** A person signed in who owns a team. Never a key.

**Chokh Pro:** the `teams` feature.

**Body:**

- `name`, text, required

### DELETE /api/ee/teams/:teamId

Deletes a team that holds no site.

**Who:** A person signed in who owns the team. Never a key.

**Chokh Pro:** the `teams` feature.

### PUT /api/ee/sites/:siteId/team

Moves a site to another team the caller owns.

**Who:** A person signed in who owns the team. Never a key.

**Chokh Pro:** the `teams` feature.

**Body:**

- `teamId`, text, required
- `revokeKeys`, true or false

## Single sign-on (Chokh Pro)

### GET /api/ee/oidc

Whether single sign-on is on, for the sign-in page.

**Who:** Anybody.

**Chokh Pro:** the `oidc` feature.

### GET /api/ee/oidc/start

Sends the browser to the identity provider to sign in.

**Who:** Anybody.

**Chokh Pro:** the `oidc` feature.

### GET /api/ee/oidc/callback

Where the provider sends the browser back; signs the person in.

**Who:** Anybody.

**Chokh Pro:** the `oidc` feature.

**Query:**

- `code`, text
- `state`, text
- `error`, text

### POST /api/ee/oidc/invite

Uses an invitation by signing in with the provider.

**Who:** Anybody.

**Chokh Pro:** the `oidc` feature.

**Body:**

- `token`, text, required

### POST /api/ee/oidc/link

Connects the account signed in to an identity at the provider.

**Who:** A person signed in. Never a key.

**Chokh Pro:** the `oidc` feature.

### GET /api/ee/oidc/identity

Whether the account signed in is connected, and to what.

**Who:** A person signed in. Never a key.

### DELETE /api/ee/oidc/identity

Disconnects it, unless it is the account's only way in.

**Who:** A person signed in. Never a key.

## Checking a licence (Chokh Pro)

### GET /api/sites/:siteId/ee/ping

Answers only when the licence key covers paid features: a way to check a key works.

**Who:** A session or a key with `read:stats` on the site.

**Chokh Pro:** the `ee.ping` feature.
