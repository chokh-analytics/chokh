---
title: Events from your server
lead: Send what your server knows, an order paid or a signup completed, and sign who a page says it is.
description: Send events and identifies to Chokh from Node with @chokh/sdk-node.
---

`@chokh/sdk-node` needs nothing beyond Node's own library, Node 22 or newer,
and works as an ES module or CommonJS. It is not on npm yet: it is published
with Chokh's first release.

```bash
npm install @chokh/sdk-node
```

## Send events

Make a key for the site with the `write:events` scope, signed in as an admin
of the site, and keep it on the server. The token is shown once, in the
answer:

```bash
curl -b jar -X POST https://analytics.example.com/api/sites/my_site/keys \
  -H 'content-type: application/json' \
  -d '{"name":"Checkout server","scopes":["write:events"]}'
```

```ts file=node/events.ts
```

`track` and `identify` return at once and never throw: the events wait in a
queue and go in the background, so analytics is never the reason a request
hangs. Delivery is at least once: a batch the network lost after Chokh stored
it may be sent again.

Pass the browser's visitor id when you know it, and the event joins the visit
that person is in the middle of.

## Sign an identify

A page can call `identify` with any id, and a forged one would be one visitor
reading another's history. So a site can refuse an identify that is not
signed, and keep the signing secret on its server:

```ts file=node/sign-identify.ts
```

The page then passes the signature as the fourth argument:
`pa('identify', user.id, { plan: 'pro' }, signature)`. The secret is shown
once, when the site is made, and again only when it is changed. It never
reaches a browser.

The signature is one line, so a server in any language can make it:

```text
base64url(hmac_sha256(identifySecret, siteId + "\n" + userId))
```
