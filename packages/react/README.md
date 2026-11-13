# @chokh/react

[Chokh](https://github.com/chokh-analytics/chokh) in a React app.
`<ChokhProvider>` loads the tracker once; `useTrack` sends your events. No
tracker code is in this package: `a.js` comes from your Chokh server, as it
does without React. React 18.2 or newer; ES modules and CommonJS.

```bash
npm install @chokh/react
```

```tsx
import { ChokhProvider } from '@chokh/react';

export function Root() {
  return (
    <ChokhProvider site="my_site" src="https://analytics.example.com/a.js" vitals errors>
      <App />
    </ChokhProvider>
  );
}
```

```tsx
import { useTrack } from '@chokh/react';

function SignUp() {
  const track = useTrack();
  return <button onClick={() => track('signup', { plan: 'pro' })}>Sign up</button>;
}
```

## Pageviews

There is no `trackPageview`, on purpose. The tracker counts the first page when
it boots and every client-side navigation after it (it watches
`history.pushState`, `replaceState` and `popstate`), which covers React Router,
TanStack Router and anything else that changes the URL. A wrapper that sent its
own pageview would count every page twice, so this one never does, and React
strict mode cannot double one either: the provider adds the tag once per
document, found again by id, however many times its effect runs.

## The provider

| Prop | Tag attribute | What it does |
| --- | --- | --- |
| `site` | `data-site` | The site key. Required. |
| `src` | | The tracker's URL: `a.js` on your Chokh server, or a first-party path that serves it. Required. |
| `api` | `data-api` | Where events go, for a first-party collect path such as `/_pa`. Left out, they go to `api/collect` beside `src`. |
| `visitorId` | `data-visitor-id` | `'persistent'` keeps an id in `localStorage` that a sign out can rotate; `'cookieless'` (the default) stores nothing. |
| `hashRouting` | `data-hash` | Count a change of `#hash` as a page. |
| `respectDnt` | `data-dnt` | Honour Do Not Track. |
| `consent` | `data-consent` | Left out: no consent gate. A boolean: nothing is sent until it is `true`, and setting it back to `false` throws away anything held. |
| `nonce` | | A Content-Security-Policy nonce, set on every script the provider adds. |
| `vitals`, `errors` | | Load `v.js` (Core Web Vitals) and `e.js` (JavaScript errors): `true` for the file beside `src`, a string for its own URL. |

The provider renders its children and nothing else. On a server it renders
exactly what the server would without it; the tag is added in an effect, which a
server never runs. It is never removed on unmount: removing a script does not stop
it.

The settings are read once, when the tracker boots, the same as a tag written by
hand. `consent` is the one prop that follows its value: the starting `false` means
"not asked yet" and holds events; `true` sends them; a later `false` withdraws.

```tsx
const [granted, setGranted] = useState(readStoredConsent());
<ChokhProvider site="my_site" src={TRACKER} consent={granted}>
```

## Hooks and functions

```ts
const track = useTrack();                 // the same function on every render
const { identify, reset, consent } = useChokh();

identify(user.id, { plan: 'pro' }, signature); // signature from your server, see below
reset();                                        // on sign out
```

They need no provider: they call the tracker's `window.pa`, or, before it has
booted, its queue, which it replays when it does. So they also work beside
`@chokh/next`'s `<Analytics />` or a tag written by hand. The same four exist as
plain functions (`track`, `identify`, `reset`, `consent`) for code outside a
component. On a server every one of them does nothing.

Property values reach the reports as strings; an empty value is left out.

A site that refuses unsigned identifies needs the signature as the third
argument of `identify`. Your server makes it with `signUserId` from
[`@chokh/sdk-node`](../sdk-node) and the site's `identifySecret`, which never
reaches a browser.

## License

MIT.
