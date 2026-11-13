// The page's side of the tracker's command interface, typed.
//
// a.js installs window.pa and reads everything else from its own script tag, so
// a wrapper needs nothing of the tracker but this: call pa, and if a.js has not
// booted yet, call the documented stub instead, which keeps each call in pa.q for
// a.js to replay when it does. Nothing of the tracker is copied here. In
// particular there is no pageview: a.js counts the first one when it boots and
// every client navigation after it (it patches history.pushState and
// replaceState and listens to popstate), so a wrapper that sent one would count
// every page twice.

export type ChokhProps = Record<string, string | number | boolean | null | undefined>;

type PaArgs = [string, ...unknown[]];
type Pa = ((...args: PaArgs) => void) & { q?: PaArgs[] };

// Read through one accessor rather than declared on the global Window. A
// declaration here would ship in this package's types, and an application that
// already declares its own window.pa (most hand-wired ones do) would stop
// compiling over two declarations of one property.
interface PaHost {
  pa?: Pa;
}

function host(): PaHost {
  return window as unknown as PaHost;
}

// The same stub the tracker's README documents, as a string a server can render
// inline ahead of the tag, so a call made while the page is still parsing waits
// rather than being lost.
export const CHOKH_QUEUE_STUB =
  'window.pa=window.pa||function(){(window.pa.q=window.pa.q||[]).push(arguments)};';

function browser(): boolean {
  return typeof window !== 'undefined';
}

// Install the stub unless something (the stub or the booted tracker) is there.
export function ensureStub(): void {
  if (!browser() || host().pa !== undefined) return;
  const stub: Pa = (...args: PaArgs) => {
    (stub.q = stub.q ?? []).push(args);
  };
  host().pa = stub;
}

function pa(...args: PaArgs): void {
  if (!browser()) return;
  ensureStub();
  host().pa?.(...args);
}

// A custom event, with properties a report can break it down by. Values reach
// the reports as strings; an empty one is left out.
export function track(name: string, props?: ChokhProps): void {
  pa('event', name, props);
}

// Name the visitor. signature is the site's HMAC of the userId, issued by your
// server with signUserId from @chokh/sdk-node; a site that refuses unsigned
// identifies needs it, and the identifySecret it is made from never reaches a
// browser.
export function identify(userId: string, traits?: ChokhProps, signature?: string): void {
  pa('identify', userId, traits, signature);
}

// Forget the person (on sign out), and in persistent mode the visitor id too, so
// the next person on a shared browser starts as somebody new.
export function reset(): void {
  pa('reset');
}

// Grant or withdraw consent on a page whose tag carries data-consent. Until it
// is granted nothing is sent; withdrawn, whatever was waiting is thrown away.
export function consent(granted: boolean): void {
  pa('consent', granted);
}
