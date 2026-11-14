---
title: A first-party path
lead: Serve the tracker and its collect address from your own domain, and still count each visitor at their own address.
description: Proxy Chokh's tracker and collector through your own domain, with the visitor's address signed.
---

Filter lists block third-party analytics hosts. A path on your own domain,
such as `/_pa`, is not on them, and a page that sends no referrer still has
an origin the collector can check. It costs one thing: your proxy is now the
peer the collector sees, so without the step below every visitor would be
stored at your proxy's address.

On Next.js, [`@chokh/next`](/nextjs/) does all of this. Anywhere else, two
pieces.

## The tracker file

`a.js` (and `v.js`, `e.js`) are plain files: a rewrite or a plain proxy of
`/_pa/a.js` to `https://analytics.example.com/a.js` is right for them. Point
the tag at your path, and say where to post:

```html
<script defer data-site="my_site" data-api="/_pa" src="/_pa/a.js"></script>
```

## The collect address

`POST /_pa/collect` has to carry the visitor's address across, signed, or
anybody could claim any address. In Node, with `@chokh/sdk-node`:

```ts file=node/forward.ts
```

Then tell your Chokh to believe it:

```ini
REAL_IP_HEADER=X-Chokh-Forwarded-For
CHOKH_PROXY_SECRET=<the same 32 or more characters as your proxy>
```

Four things to know:

- **A bad signature is never a refusal.** A missing, forged or stale one falls
  back to the address the collector sees, and the batch is still counted. A
  mistake in your proxy costs addresses, not traffic.
- **The secret is for servers only.** A browser that could read it could
  claim any address.
- **Forward the browser's own headers:** the user agent, the Client Hints and
  the origin, as in the example. A proxy that sends its own user agent turns
  every visitor into that.
- **The signature lasts two minutes,** either side of the moment it was made,
  so a header copied out of a log is worth nothing soon after.

In another language, the signature is
`base64url(hmac_sha256(CHOKH_PROXY_SECRET, address + "\n" + ts))`, with `ts`
the time in milliseconds, sent as `X-Chokh-Forwarded-Sig: <ts>.<signature>`.
