# @chokh/sdk-node

What your own server needs from [Chokh](../../README.md): send events it knows
about, and sign an identify so a page cannot claim to be somebody it is not.

```bash
npm install @chokh/sdk-node
```

## Events your backend knows about

An order that was paid, a signup that completed, an identify for a browser that
blocks the tracker: facts a server is sure of and a page either cannot see or
cannot be trusted about.

```ts
import { createClient } from '@chokh/sdk-node';

const chokh = createClient({
  url: process.env.CHOKH_API_URL,   // https://analytics.example.com
  siteId: process.env.CHOKH_SITE,   // my_site
  apiKey: process.env.CHOKH_API_KEY, // a key carrying write:events
});

await chokh.identify('u_42', { plan: 'pro' });
await chokh.track('u_42', 'order_paid', { value: 1200, path: '/checkout' });
```

Pass the browser's `visitorId` when you know it and the event joins the stay that
person is in the middle of:

```ts
await chokh.send({
  userId: 'u_42',
  visitorId: cookies.get('chokh_vid'),
  events: [{ type: 'event', name: 'order_paid', value: 1200 }],
});
```

A failure raises a `ChokhError` carrying the `code` the API refused with, so a
caller can tell a wrong scope from a site that does not exist. There is no
batching, no queue and no retry: analytics must never be the reason a checkout
hangs, so either await it somewhere that can afford five seconds, or do not await
it at all.

## Signing an identify

A page can call `pa('identify', 'u_someone')` with any id it likes, and the
collector cannot tell a real login from somebody typing into the console. On a
site whose administrators can then read that person's addresses and pages, a
forged identify is one visitor reading another's history.

So a site that cares turns `allowUnsignedIdentify` off, keeps the site's
`identifySecret` on its server, and hands the page a signature:

```ts
import { signUserId } from '@chokh/sdk-node';

// In whatever your page reads its own session from.
const sig = signUserId(process.env.CHOKH_IDENTIFY_SECRET, 'my_site', user.id);
```

```js
pa('identify', user.id, { plan: 'pro' }, sig);
```

The secret never reaches a browser: one that could read it could sign anything.
It is shown once when the site is created, and again only when it is rotated
through `POST /api/sites/:siteId/identify-secret/rotate`.

The formula is one line on purpose, so a server in another language can issue the
same signature from this description alone:

```
base64url(hmac_sha256(identifySecret, siteId + "\n" + userId))
```

The site is in the signed string, so a signature issued for one site cannot be
replayed at another. It is not bound to a moment, so anybody who captured one can
replay it for that user: that is the same trust as holding the person's session,
which is the level this is meant to reach.

The collector verifies these signatures with its own copy of that one line rather
than importing this package, because a product should not depend on its own client
SDK. A shared test vector asserted in both packages is what keeps the two from
drifting apart.

## Signing a forwarded address

The other signature, for the other half of a first-party setup. If you serve the
collect path from your own domain (`data-api="/_pa"`), your proxy is the peer the
collector sees, so without this every visitor of your site is stored as the
proxy: one address, one country, and in cookieless mode one visitor id for
everybody.

The proxy carries the visitor's address across and signs it, because a header
anybody can set is an address anybody can claim:

```ts
import { signForwardedAddress } from '@chokh/sdk-node';

const ts = Date.now();
headers.set('X-Chokh-Forwarded-For', ip);
headers.set('X-Chokh-Forwarded-Sig', `${ts}.${signForwardedAddress(secret, ip, ts)}`);
```

The secret is the collector's `CHOKH_PROXY_SECRET`, which is server side always:
a browser that could read it could claim any address. The collector reads the
pair only when it runs with `REAL_IP_HEADER=X-Chokh-Forwarded-For`, and it falls
back to the peer chain whenever the signature does not check out, so a mistake
here costs you the addresses and never the traffic.

The formula, again in one line, so a proxy in another language can issue the same
signature from this description alone:

```
base64url(hmac_sha256(CHOKH_PROXY_SECRET, address + "\n" + ts))
```

`ts` is the Unix time in milliseconds, and the collector believes one within 120
seconds of the moment the request arrived, either side. Unlike the identify
signature this one is bound to a moment on purpose: a header read out of a proxy
log is worth nothing two minutes later.

## License

MIT.
