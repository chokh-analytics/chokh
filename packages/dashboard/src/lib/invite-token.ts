// The token of an invitation link, taken out of the address bar and kept in
// memory and nowhere else (AN-TEAM01).
//
// An invitation link is /invite#<token>. The token is in the fragment because
// a browser never sends a fragment to a server, so it is in no access log and
// no Referer. What is left to guard is this side: the address bar, the
// history, anything a later script or an extension reads from location, and a
// screenshot. So the fragment is taken off before anything else runs, by six
// lines inline in index.html that run before any module is even fetched, and
// this file is where the page then collects it from.
//
// Kept in one variable in this module. Never in a URL or a query, never in
// localStorage or sessionStorage, never on window once it has been collected.
// A reload therefore forgets it, on purpose: the page says so and asks for
// the link to be opened again.

declare global {
  interface Window {
    // Set by the inline script in index.html and cleared the first time this
    // module is asked. Present for a few milliseconds.
    __chokhInvite?: string;
  }
}

export const INVITE_PATH = '/invite';

let held: string | null = null;

// The same step the inline script takes, for anywhere that script did not run
// (a test, a dev server that serves another shell): if the fragment is still
// there, it is taken off now.
function collect(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const parked = window.__chokhInvite;
  if (typeof parked === 'string') {
    delete window.__chokhInvite;
    if (parked !== '') held = parked;
  }
  if (window.location.pathname === INVITE_PATH && window.location.hash.length > 1) {
    held = window.location.hash.slice(1);
    window.history.replaceState(window.history.state, '', INVITE_PATH);
  }
}

// The token this page was opened with, or null when it was opened without one
// (or reloaded since). Reading it does not forget it: the page needs it for
// the lookup and again for the acceptance.
export function inviteToken(): string | null {
  collect();
  return held;
}

// Forgotten once it has been used, or when the person leaves the page.
export function forgetInviteToken(): void {
  held = null;
}

// A link opened in a tab that is already on this page is a change of fragment
// and not a load: no script runs again, and the token would sit in the address
// bar. So the fragment is watched, taken off the same way, and whoever is
// listening is told there is a token to read.
const listeners = new Set<() => void>();

export function onInviteToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const before = held;
    collect();
    if (held !== before) {
      for (const listener of listeners) listener();
    }
  });
}

// Run on import, so the entry file takes the fragment off by importing this
// first, before the application's own modules are evaluated.
collect();
