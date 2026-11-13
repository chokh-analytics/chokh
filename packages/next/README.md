# @chokh/next

[Chokh](https://github.com/chokh-analytics/chokh) in a Next.js App Router app,
first-party: the tracker served from your own origin, its events posted to your
own origin and forwarded with the visitor's real address. Three files, one line
each. Next 15 or 16, React 18.2 or newer, Node 22 or newer.

```bash
npm install @chokh/next
```

**1. `next.config.mjs`**: serve `a.js`, `v.js` and `e.js` under `/_pa`.

```js
import { withChokh } from '@chokh/next/config';

export default withChokh(nextConfig, { url: process.env.NEXT_PUBLIC_CHOKH_URL });
```

**2. `app/%5Fpa/collect/route.ts`**: the collect path, `/_pa/collect`.

```ts
import { createCollectRoute } from '@chokh/next/collect';

export const POST = createCollectRoute({
  url: process.env.NEXT_PUBLIC_CHOKH_URL,
  proxySecret: process.env.CHOKH_PROXY_SECRET,
});
```

The folder is `%5Fpa`, not `_pa`: a folder whose name starts with an underscore
is private in the App Router and never routed, and `%5F` is how a segment that
really starts with one is written.

**Where the visitor's address comes from: read this before you deploy.** The
route signs the address it forwards, and the signature is what makes the
collector believe it. So it must read a header your host sets itself, never
one a visitor can send. By default it reads the first entry of
`x-forwarded-for` (else `x-real-ip`). That is right on Vercel, which documents
that it overwrites `x-forwarded-for` with the address it saw. On a host that
passes the header through, or appends to it, the first entry is whatever the
visitor typed, and the route would sign it. Say where the address is instead:

```ts
import { addressFrom, createCollectRoute } from '@chokh/next/collect';

export const POST = createCollectRoute({
  url: process.env.NEXT_PUBLIC_CHOKH_URL,
  proxySecret: process.env.CHOKH_PROXY_SECRET,
  clientAddress: addressFrom.cloudflare,
});
```

| Your app runs | Pass | Why |
| --- | --- | --- |
| On Vercel | nothing (the default, `addressFrom.firstForwardedFor`) | Vercel overwrites `x-forwarded-for` with the address it saw. |
| Behind Cloudflare, the origin answering only to Cloudflare | `addressFrom.cloudflare` | Cloudflare sets `CF-Connecting-IP` to the address that connected to it; it appends to an `x-forwarded-for` the visitor sent. |
| Behind your own nginx that sets `proxy_set_header X-Real-IP $remote_addr` | `addressFrom.header('x-real-ip')` | nginx writes the address it saw over whatever the visitor sent. |
| Behind one proxy that appends (`$proxy_add_x_forwarded_for`), nothing else in between | `addressFrom.lastForwardedFor` | The last entry is the one that proxy added. |
| `next start` with nothing in front | `() => undefined` | There is no header you can trust; the collector then stores your server's address. |
| Anywhere else | a function `(request) => string \| undefined` | Read the one header your platform documents as set by its edge. |

The Vercel, Cloudflare and nginx rows are from those projects' own
documentation; for any other host, check its documentation for the header its
edge sets. A function that answers nothing, or throws, signs nothing. A body
larger than 64 KiB (`maxBodyBytes`) is not forwarded; the tracker's batches are
a few kilobytes.

**3. `app/layout.tsx`**: the tag.

```tsx
import { Analytics } from '@chokh/next';

<body>
  {children}
  <Analytics site="my_site" visitorId="persistent" vitals errors />
</body>
```

Then track your own events anywhere in a client component:

```tsx
'use client';
import { useTrack } from '@chokh/next';

const track = useTrack();
track('signup', { plan: 'pro' });
```

## Why the collect path is a route and not a rewrite

A rewrite is fetched by your host's own infrastructure, so the collector would
see the host as every visitor's address: one machine in one data centre, the
wrong country on every row, and with cookieless ids one visitor for everybody.
The route is the proxy instead. It forwards the browser's own headers (origin,
user agent, Client Hints; never a cookie or an authorization header) and sends
the visitor's address in `X-Chokh-Forwarded-For`, signed in
`X-Chokh-Forwarded-Sig` with `CHOKH_PROXY_SECRET`, because a header anybody can
set is an address anybody can claim. Run the Chokh server with
`REAL_IP_HEADER=X-Chokh-Forwarded-For` and the same `CHOKH_PROXY_SECRET`. Without
the secret the route still forwards, and the collector stores your host's
address. The route never refuses and never throws: a forward that fails answers
`202` and the batch is lost, so analytics never costs a page a request. The
signature is made with Web Crypto, so the route runs on the Node and the Edge
runtime alike.

The scripts are static files with nobody's address in them, so for them a
rewrite is right. With the URL unset (a preview deployment without the variable)
`withChokh` adds nothing and the route forwards nothing.

## Pageviews

`<Analytics />` sends none. The tracker counts the first page when it boots and
every client navigation after it; the App Router navigates with
`history.pushState`, which the tracker watches. So a page load and a `<Link>`
each count once, as the example app in this repository proves on Next 15 and 16
against the real server.

## `<Analytics />`

| Prop | What it does |
| --- | --- |
| `site` | The site key. Required. |
| `path` | The first-party path, default `/_pa`: the tracker is `/_pa/a.js` and posts to `/_pa/collect`. |
| `src` | The tracker's URL when it is not served first-party; it then posts beside itself unless `api` says otherwise. |
| `api` | Where events go, if not the default. |
| `visitorId` | `'persistent'` or `'cookieless'` (the tracker's default). |
| `hashRouting`, `respectDnt` | Count `#hash` changes as pages; honour Do Not Track. |
| `vitals`, `errors` | Load `v.js` (Core Web Vitals) and `e.js` (JavaScript errors) from beside the tracker, or from a URL you give. |
| `consent` | Left out: no gate. A boolean: nothing is sent until it is `true`; a later `false` withdraws. |
| `nonce` | A Content-Security-Policy nonce, given to the inline stub and every script. |

It renders the tracker's queue stub inline, so a `track()` or a report from
`v.js` that runs before `a.js` boots waits for it, then the scripts through
`next/script`, after hydration and off the first paint's path.

`useTrack`, `useChokh`, `useConsent` and the plain `track`, `identify`, `reset`
and `consent` are [`@chokh/react`](../react)'s, re-exported. A site that refuses
unsigned identifies passes the signature its server made with `signUserId` from
[`@chokh/sdk-node`](../sdk-node): `identify(user.id, traits, signature)`.

`withChokh` keeps whatever `rewrites()` your config already returns: a plain list
stays in the `afterFiles` phase, and the tracker's three go first in
`beforeFiles`. `chokhRewrites({ url })` is the same list for a config that writes
its own.

## License

MIT.
