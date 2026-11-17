---
title: Quickstart
lead: Count a site in five minutes, with a script tag on any site, or with the package for Next.js or React.
description: Add Chokh to a site: the script tag, Next.js or React, and your first event.
---

You need a running Chokh and a site in it. If you have neither,
[run it first](/self-hosting/): one `docker compose up`, one account, one site.
Below, `my_site` is your site's id and `https://analytics.example.com` is the
address your install answers on.

> The script tag works on any site. For a Next.js or React app, or to send
> events from a server, there are the npm packages `@chokh/next`,
> `@chokh/react` and `@chokh/sdk-node`.

## Add the tracker

Pick your framework once; every example on these pages then follows it.

```html HTML file=html/tag.html
```

```tsx Next.js file=next/app/layout.tsx
```

```tsx React file=react/root.tsx
```

That is the whole of it. The tracker counts the first page and every page
after it, a single page app's route changes included, so there is no
`trackPageview` to call. On Next.js the tag is one of three files, and the
tracker is served from your own domain; the [Next.js page](/nextjs/) has the
other two.

`vitals` and `errors` also load the scripts for Core Web Vitals and
JavaScript errors, which the Health report reads. Leave them off to collect
pageviews alone.

## Send an event

```html HTML file=html/event.html
```

```tsx Next.js file=next/app/signup-button.tsx
```

```tsx React file=react/signup-button.tsx
```

An event's properties are what the site chooses to say about it, like a plan
or a quiz id, and anybody who can read the site's reports sees them. What is
about a person belongs in `identify`, which only an account allowed to read
identities sees.

## Count what your server knows

An order that was paid, a signup that completed: facts a server is sure of
and a page cannot be trusted with. [Events from your server](/server-events/)
sends them with a key.

## What is counted, and what is kept

By default the tracker sets no cookie and stores nothing in the browser, and
the collector keeps no full address: it tells visitors apart by the address,
the browser and a salt that changes every day, and stores the address with
its last part zeroed.
A site that signs people in can choose a visitor id kept in the browser and
full addresses instead, as settings of that site. The tracker honours Do Not
Track when the tag carries `data-dnt`, and sends nothing until consent when it
carries `data-consent`.
