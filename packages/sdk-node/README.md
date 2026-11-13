# @chokh/sdk-node

What your own server needs from [Chokh](https://github.com/chokh-analytics/chokh):
send events it knows about, and sign an identify so a page cannot claim to be
somebody it is not. No dependency beyond Node's standard library; Node 22 or
newer; ES modules and CommonJS both.

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
  url: process.env.CHOKH_URL,        // https://analytics.example.com
  siteId: process.env.CHOKH_SITE,    // my_site
  apiKey: process.env.CHOKH_API_KEY, // a key carrying write:events, never in a page
});

chokh.identify('u_42', { plan: 'pro' });
chokh.track('u_42', 'order_paid', { value: 1200, path: '/checkout', props: { currency: 'BDT' } });
```

`track` and `identify` return at once and never throw: the events wait in a queue
and go in the background, so analytics is never the reason a checkout hangs. Pass
the browser's `visitorId` when you know it and the event joins the stay that person
is in the middle of: `chokh.track('u_42', 'order_paid', { visitorId })`.

A server identify needs no signature. The key is the proof: the route trusts the
`userId` a `write:events` key sends, which is exactly what a browser's signed
identify (below) stands in for.

### How the queue behaves

| What | Default | Option |
| --- | --- | --- |
| A request carries one person's events, at most | 50 (the route's limit) | |
| A flush starts when this many events are queued | 20 | `flushAt` |
| or this long after the first of them | 1 s | `flushIntervalMs` |
| At most this many events wait; a full queue drops its oldest | 1,000 | `maxQueueSize` |
| Requests in flight at once, never two for one person | 4 | `concurrency` |
| One request may take | 5 s | `timeoutMs` |
| Retries, on a network error, a 5xx, a 408 or a 429 | 5 | `maxRetries` |
| Each wait is random, below a ceiling that doubles from 500 ms up to 30 s, or what `Retry-After` asks, up to 30 s | | `retryBaseMs`, `retryMaxMs` |
| `shutdown()` keeps sending for | 5 s | `shutdownTimeoutMs` |

A request carries one person, so the client delivers at most `concurrency`
people per round trip to the server: with the default and a 50 ms round trip,
80 requests a second of up to 50 events each. Past that the queue fills and
drops its oldest, so a backend that names more people than that each second
raises `concurrency`. One person never has two requests in flight, so each
person's events arrive in the order they were tracked.

With the defaults a request that keeps failing gives up within about sixteen
seconds of waiting. A 408 or a 429 (which a proxy in front of a Chokh server can
send, though the route itself does not) is retried like a 5xx. Any other 4xx is
never retried: the server refused the request, and the same request would be
refused again. An event outside the route's limits or of the wrong type (a name
over 120 characters, more than 40 properties, a property over 512 characters or
that is not a string, number or boolean, a value that is not a finite number, a
path that is not a string) is refused when you track it, alone, so it cannot take
49 good events down with it. An event carries the moment you tracked it; the
server moves anything older than 24 hours to 24 hours ago.

**Delivery is at least once.** A request whose answer is lost after the server
stored it (a timeout, a dropped connection) is sent again, and the server keeps
both copies: nothing on the route folds a repeated server event.

**Nothing is dropped silently.** Every event that leaves the queue unstored is
handed to `onDrop` with a reason: `invalid`, `queue_full`, `rejected` (a 4xx,
with the server's error code), `retries_exhausted` or `shutdown`. The default
writes one `console.warn` line; pass your own to count them or send them to your
logger:

```ts
const chokh = createClient({
  url, siteId, apiKey,
  onDrop: ({ reason, events, message }) => log.warn({ reason, count: events.length }, message),
});
```

### Flushing and stopping

`await chokh.flush()` sends everything queued and resolves with `{ sent, dropped }`;
it never rejects. When the process's event loop runs dry (a script that has done
its work) the client flushes by itself. It installs no signal handler, because a
library that catches `SIGTERM` changes how your process exits; stop it in your own:

```ts
process.on('SIGTERM', () => {
  chokh.shutdown().finally(() => process.exit(0));
});
```

`shutdown()` sends what is queued for up to five seconds, drops the rest (and says
so through `onDrop`), and refuses events tracked after it.

### One request, now

`send` posts a batch at once, outside the queue and with no retry, and resolves
with the visitor the events landed on, or rejects with a `ChokhError` carrying the
`code` and `status` the server answered with:

```ts
const { visitorId } = await chokh.send({
  userId: 'u_42',
  events: [{ type: 'event', name: 'order_paid', value: 1200 }],
});
```

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
