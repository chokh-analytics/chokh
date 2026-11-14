---
title: Chokh, Plausible, Umami and GA4
lead: What each one is, what it costs, and what it does, from each product's own pages, read on 15 November 2026.
description: A comparison of Chokh with Plausible, Umami and Google Analytics 4, every claim linked to the product's own documentation or pricing page.
---

Every statement here about Plausible, Umami or Google Analytics 4 links to
that product's own documentation or pricing page, as it read on 15 November
2026; where their own pages did not say, the cell says so rather than
guess. Products change: follow the link before you decide. Chokh's own cells
link to these docs, so you can check us the same way.

## In short

Chokh is for somebody who wants to host their analytics themselves, keep the
data on their own server, and still have funnels, retention, identified
people and an API without a paid plan. If you would rather not run a server,
each of the other three has a hosted service and Chokh has none.

## What each one is

| | Chokh | Plausible | Umami | Google Analytics 4 |
| --- | --- | --- | --- | --- |
| Licence | MIT, except `packages/ee`, under a commercial licence ([licence](/licence/)) | AGPLv3 for the self-hosted Community Edition ([GitHub](https://github.com/plausible/analytics)) | MIT ([pricing](https://umami.is/pricing)) | Not stated on the pages read |
| Self-hosted | Yes, on PostgreSQL 15+ or MongoDB 5+ ([self-hosting](/self-hosting/)) | Yes, Community Edition, on PostgreSQL and ClickHouse ([GitHub](https://github.com/plausible/analytics)) | Yes, on PostgreSQL ([GitHub](https://github.com/umami-software/umami)) | No self-hosted edition stated on the pages read |
| Hosted service | None | From $9 a month for 10k pageviews, 30-day trial ([pricing](https://plausible.io/#pricing)) | Free for 100K events a month and one site; Pro $20 a month ([pricing](https://umami.is/pricing)) | Free; Analytics 360 is the paid tier ([Google](https://marketingplatform.google.com/about/analytics/)) |
| Where hosted data is kept | On your own server | "Visitor data does not leave the EU" ([data policy](https://plausible.io/data-policy)) | US and EU ([pricing](https://umami.is/pricing)) | Not stated on the pages read |
| Cookies | None by default; a site may choose an id kept in the browser ([quickstart](/quickstart/#what-is-counted-and-what-is-kept)) | None ([data policy](https://plausible.io/data-policy)) | None ([pricing](https://umami.is/pricing)) | `_ga` and `_ga_<container-id>`, two years each ([Google](https://support.google.com/analytics/answer/11397207)) |
| Raw data kept | 1 to 3650 days per site, set by you, 180 by default ([self-hosting](/self-hosting/#how-long-data-is-kept)) | No retention limit, from the cheapest plan ([pricing](https://plausible.io/#pricing)) | 6 months free, 2 years Pro, 5 years Business ([pricing](https://umami.is/pricing)) | 2 or 14 months; longer on 360 ([Google](https://support.google.com/analytics/answer/7667196?hl=en)) |

## What each one does

| | Chokh | Plausible | Umami | Google Analytics 4 |
| --- | --- | --- | --- | --- |
| Realtime | Yes ([API](/api/#get-api-sites-siteid-realtime)) | Yes ([docs](https://plausible.io/docs)) | Yes, every plan ([pricing](https://umami.is/pricing)) | Yes ([Google](https://support.google.com/analytics/answer/9271392)) |
| Custom events and goals | Yes ([quickstart](/quickstart/#send-an-event)) | Yes, from the cheapest plan ([pricing](https://plausible.io/#pricing)) | Yes, every plan ([pricing](https://umami.is/pricing)) | Yes, as events and key events ([Google](https://support.google.com/analytics/answer/7667196?hl=en)) |
| Funnels | Yes ([API](/api/#get-api-sites-siteid-stats-funnel)) | Business plan and up; not in the Community Edition ([pricing](https://plausible.io/#pricing), [CE](https://plausible.io/self-hosted-web-analytics)) | Yes, every plan ([pricing](https://umami.is/pricing)) | Yes, funnel exploration ([Google](https://support.google.com/analytics/answer/7667196?hl=en)) |
| Retention cohorts | Yes ([API](/api/#get-api-sites-siteid-stats-cohorts)) | Not stated on the pages read | Yes, every plan ([pricing](https://umami.is/pricing)) | Yes, cohort exploration ([Google](https://support.google.com/analytics/answer/9670133)) |
| Signed-in people by your own id | Yes, signed by your server if you want ([events from your server](/server-events/#sign-an-identify)) | Not stated on the pages read | Yes, distinct IDs ([docs](https://docs.umami.is/docs/distinct-ids)) | Yes, User-ID ([Google](https://support.google.com/analytics/answer/10976610?hl=en)) |
| A stats API | Yes, every route ([API](/api/)) | Business plan and up ([pricing](https://plausible.io/#pricing)) | Pro plan and up ([docs](https://docs.umami.is/docs/cloud)) | An API exists ([Google](https://support.google.com/analytics/answer/1008004?hl=en)) |
| Single sign-on | From your own application, free; OpenID Connect with a key ([licence](/licence/#what-is-in-each-half)) | Enterprise plan, SAML ([docs](https://plausible.io/docs/sso)) | Enterprise plan, SAML ([pricing](https://umami.is/pricing)) | Not stated on the pages read |
| Export | CSV of any report ([API](/api/#get-api-sites-siteid-export-csv)) | CSV ([CE](https://plausible.io/self-hosted-web-analytics)) | Data export on every plan ([pricing](https://umami.is/pricing)) | BigQuery export, free up to 1 million events a day ([Google](https://support.google.com/analytics/answer/9358801?hl=en)) |
| Import from another tool | Plausible, Umami and GA4 history ([README](https://github.com/chokh-analytics/chokh#importing-history)) | Google Analytics import ([pricing](https://plausible.io/#pricing)) | Pro plan and up ([pricing](https://umami.is/pricing)) | Not stated on the pages read |

## The script a page loads

Measured by us on 15 November 2026: each tracker as its own host serves it,
compressed with `gzip -9`, in bytes. Your browser may receive a different
compression; the comparison is the same command for all four.

| | Script | Bytes, gzip -9 |
| --- | --- | --- |
| Chokh | `a.js`, built from this repository at `a30330e` | 2,873 |
| Plausible | `https://plausible.io/js/script.js` | 1,285 |
| Umami | `https://cloud.umami.is/script.js` | 4,132 |
| Google Analytics 4 | `https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX` (a placeholder id; a real property's file may differ) | 155,023 |

The command, for each address:

```bash
curl -s "$URL" | gzip -9 -c | wc -c
```

Chokh's `v.js` (Core Web Vitals) and `e.js` (errors) are separate, loaded
only when asked for, and are not counted above.
