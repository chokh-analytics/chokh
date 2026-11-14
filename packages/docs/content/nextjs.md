---
title: Next.js
lead: Chokh in an App Router app, first-party: the tracker served from your own domain, its events posted to your own domain and forwarded with each visitor's real address.
description: Add Chokh to a Next.js App Router app with @chokh/next, in three files.
---

`@chokh/next` works with Next 15 or 16, React 18.2 or newer, and Node 22 or
newer. It is not on npm yet: it is published with Chokh's first release.

```bash
npm install @chokh/next
```

## 1. The config

`next.config.mjs` serves the tracker and its two companions under `/_pa`, from
your own origin, where filter lists do not reach.

```js file=next/next.config.mjs
```

## 2. The collect route

`app/%5Fpa/collect/route.ts` is the address the tracker posts to,
`/_pa/collect`. It forwards each batch to your Chokh with the visitor's
address, signed so the collector believes it.

```ts file=next/app/%5Fpa/collect/route.ts
```

The folder is `%5Fpa` and not `_pa`: the App Router never routes a folder whose
name starts with an underscore, and `%5F` is how a segment that really starts
with one is written.

Set the same `CHOKH_PROXY_SECRET` on your Chokh server, with
`REAL_IP_HEADER=X-Chokh-Forwarded-For` (see the
[environment](/environment/)). The secret stays on servers: it is never a
`NEXT_PUBLIC_` variable.

**Read this before you deploy.** The route signs the address it reads, so it
must read a header your host sets itself and never one a visitor can send. By
default it reads the first entry of `x-forwarded-for`, which is right on
Vercel, which documents that it overwrites that header. Anywhere else, say
where the address is with `clientAddress`; the
[package's README](https://github.com/chokh-analytics/chokh/tree/main/packages/next#readme)
has a table of hosts and what to pass for each.

## 3. The tag

```tsx file=next/app/layout.tsx
```

## Events

`useTrack`, `useChokh` and the plain `track`, `identify` and `reset` come from
the same package.

```tsx file=next/app/signup-button.tsx
```

## What `<Analytics />` takes

| Prop | What it does |
| --- | --- |
| `site` | The site's id. Required. |
| `path` | The first-party path, `/_pa` by default. |
| `visitorId` | `'persistent'` keeps an id in the browser; `'cookieless'`, the default, stores nothing. |
| `vitals`, `errors` | Load the scripts for Core Web Vitals and JavaScript errors. |
| `consent` | Nothing is sent until it is `true`; a later `false` withdraws. |
| `hashRouting`, `respectDnt` | Count a change of `#hash` as a page; honour Do Not Track. |
| `nonce` | A Content-Security-Policy nonce for every script it adds. |
