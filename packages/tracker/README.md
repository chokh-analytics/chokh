# @chokh/tracker

The browser script. One dependency-free IIFE built by esbuild to `a.js`, at most
3 KB gzipped, asserted in CI by `pnpm size:tracker`.

```html
<script defer data-site="YOUR_SITE_KEY" src="https://analytics.example.com/a.js"></script>
```

## Script tag attributes

The site's settings reach the browser on the tag, so one static file serves
every site.

| Attribute | Default | What it does |
| --- | --- | --- |
| `data-site` | required | The site key. Without it the tracker does nothing. |
| `data-api` | the script's own origin | Base path for the collector, for a first-party proxy: `data-api="/_pa"` posts to `/_pa/collect`. |
| `data-hash` | off | Count a pageview when only the hash changes, for hash routed apps. |
| `data-visitor-id` | `cookieless` | `persistent` keeps a visitor id in `localStorage` for 13 months. `cookieless` stores nothing and the collector derives the id. |
| `data-dnt` | off | Present means a visitor whose browser sends Do Not Track is not tracked at all. |
| `data-consent` | off | Present means nothing is sent until `pa('consent', true)`. |

## What it collects by itself

- A pageview on load and on `pushState`, `replaceState` and `popstate`
- A heartbeat every 20 seconds while the tab is visible, none while it is
  hidden, and one immediately when it comes back
- A leave beacon carrying time on page (visible time only) and the deepest scroll
  quartile reached (25, 50, 75 or 100), on `pagehide` and again whenever a route
  change closes a page, so every page in a single page app carries its own
- A click on any element carrying `data-pa-event`, with every
  `data-pa-prop-<name>` attribute as a property
- `outbound_link` and `file_download` clicks, each with the `url` property
- The status a page declared in `window.paStatus`, on the pageview that follows

## Telling Chokh what a page answered

A browser cannot read the status code its own page came back with, so nothing in
this script can tell a 404 from anything else: a not-found page is a pageview of
a page that happens to say "not found". The page is the only thing that knows,
so the page says so.

Set `window.paStatus` above the tag. The pageview that follows carries it.

```html
<script>
  window.paStatus = 404;
</script>
<script defer data-site="YOUR_SITE_KEY" src="https://analytics.example.com/a.js"></script>
```

Render it the way you render the page itself: the not-found template sets 404,
an error page sets 500, every other page sets nothing at all. A pageview with no
status is a pageview nobody labelled, and it is counted as exactly that and
never as a 200, so the Pages report's count of 404s is a number your site
reported rather than a guess this script made from your paths.

The value is read once and then cleared. In a single page app that means the
route change has to set it before it navigates, not from inside the component
that renders: a pageview goes as soon as the history entry changes, which is
before an effect runs. Clearing it is what stops one route setting it and every
route after that reporting itself as not found.

Only a whole number between 100 and 599 is sent, and only on a pageview.
Anything else is ignored here rather than posted, because the collector refuses
a batch carrying a status that is not one.

## Commands

```js
pa('event', 'quiz_start', { quizId: 'q1' });
pa('identify', 'user_42', { plan: 'pro' });
pa('identify', 'user_42', { plan: 'pro' }, signatureFromYourServer);
pa('reset');
pa('consent', true);
```

`identify` links this visitor to an account and flushes at once. `reset` forgets
the account, the signature and, in persistent mode, the stored visitor id, so a
logout starts a new visitor.

**In cookieless mode `reset` cannot rotate the visitor id**, because the tracker
stores nothing to rotate: the collector derives the id from the address, the
user agent and a salt that turns daily. So on a shared device, the next person
to use the browser after a logout is attributed to the person who logged out,
until the salt turns at the end of the day. Persistent mode has no such window,
because `reset` throws the stored id away and the next visitor gets a new one.
A site where people sign in on shared machines should run `persistent`.

### Signing an identify

Anything on the page can call `identify` with any id it likes, and the collector
cannot tell a real login from somebody typing into the console. On a blog that
does not matter, and the default site setting accepts an unsigned identify. On a
site where an administrator can then read that person's addresses and pages, a
forged identify is one visitor reading another's history, so that site turns
`allowUnsignedIdentify` off and passes a signature as the fourth argument.

Your server issues it from the site's `identifySecret`, which never reaches the
browser:

```
signature = base64url(hmac_sha256(identifySecret, siteId + "
" + userId))
```

Render it with the page the way you render the user's name. `sdk-node` will do
this for you in AN-API01. The signature travels on every batch after the
identify, because the `userId` does; an identify the site will not confirm is
dropped, the rest of the batch is still collected, and nothing about that
visitor is ever filed under the name.

There is a fifth command, `pa('vital', name, { value, rating })`. It is internal:
`v.js` uses it to report a Core Web Vital through this script rather than posting
on its own, so vitals share the consent gate, the visitor id and the batch. A
site never calls it.

### Calling pa() before the script loads

`a.js` is deferred, so a page that calls `pa()` during parsing needs somewhere to
put the call. Add the usual stub before any such call, and the tracker replays
whatever it finds in `pa.q` once it boots.

```html
<script>
  window.pa =
    window.pa ||
    function () {
      (window.pa.q = window.pa.q || []).push(arguments);
    };
</script>
```

## Core Web Vitals

`v.js` is optional and reports LCP, CLS, INP, TTFB and FCP through `a.js`, so
vitals share its consent gate, visitor id and batching.

```html
<script defer data-site="YOUR_SITE_KEY" src="https://analytics.example.com/a.js"></script>
<script defer src="https://analytics.example.com/v.js"></script>
```

AN-TRK01 asks for the `web-vitals` build to be inlined into `a.js` when it fits
the 3 KB budget. Measured on 2026-09-18 it does not: inlined, `a.js` is 5995 B
gzipped, which is 2923 B over. Hence the second file.

## Transport

Events are batched and sent with `navigator.sendBeacon`, falling back to a
`fetch` with `keepalive`. A batch goes after one second, as soon as it holds 20
events, on every heartbeat, when the tab is hidden, and on `pagehide`.

While `data-consent` is set and consent has not been given, nothing is sent:
heartbeats are dropped, because a beat nobody may read says nothing, and the
buffer keeps only the newest 20 events, so a tab left open for hours neither
grows without bound nor floods the collector the moment consent arrives.

The body is JSON sent with a `text/plain` content type. A beacon cannot be
preflighted, so a simple content type is the only way the primary transport
survives a cross-origin post. The collector reads the body as JSON whatever the
header says.

## Payload

```json
{
  "siteId": "YOUR_SITE_KEY",
  "sentAt": 1789700000000,
  "hostname": "example.com",
  "lang": "en-US",
  "screen": "1920x1080",
  "viewport": "1280x720",
  "visitorId": "kq2b7w3m9pa",
  "userId": "user_42",
  "sig": "optional, the site's proof of the userId above",
  "events": [
    {
      "type": "pageview",
      "ts": 1789699999000,
      "path": "/courses/cp-beginners",
      "title": "Competitive programming for beginners",
      "referrer": "https://www.google.com/",
      "utm": { "source": "facebook", "campaign": "imupc" }
    }
  ]
}
```

`type` is one of `pageview`, `event`, `heartbeat`, `leave`, `identify` or
`vital`. A pageview also carries `status` when the page declared one, as a
string of three digits. The collector enriches each event with IP, geo, user agent and bot
flags, applies the site's IP mode, exclusions and retention, and cuts the
visitor's events into sessions under a thirty minute gap rule.
