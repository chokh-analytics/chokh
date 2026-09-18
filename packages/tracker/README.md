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

## Commands

```js
pa('event', 'quiz_start', { quizId: 'q1' });
pa('identify', 'user_42', { plan: 'pro' });
pa('reset');
pa('consent', true);
```

`identify` links this visitor to an account and flushes at once. `reset` forgets
the account and, in persistent mode, the stored visitor id, so a logout starts a
new visitor.

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
`vital`. The collector enriches each event with IP, geo, user agent and bot
flags, and applies the site's IP mode, exclusions and retention. AN-COL01 builds
it.
