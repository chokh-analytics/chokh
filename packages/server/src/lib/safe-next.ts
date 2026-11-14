// Where a sign-in may send somebody afterwards: a path of this dashboard, and
// nothing a browser could read as anywhere else.
//
// An open redirect behind an authentication hop is how a link on a host
// people trust becomes a phishing link: the person signs in for real, at the
// real provider, and lands on somebody else's page. So `next` is held to an
// allow-list of characters and not to a prefix. "Starts with one slash" is not
// the rule, because a browser does not read a location the way a string
// comparison does: it takes a backslash for a slash, and drops a tab, a
// carriage return and a line feed before it reads anything, so `/\host` and
// `/<tab>/host` both leave for `//host`. None of those characters is in the
// list, and neither is a space or anything else outside what a path and a
// query of this dashboard are made of.
//
// `+` and `*` are in it. With the rest of the list that is every character
// URLSearchParams leaves as it is, so a query the dashboard wrote itself is
// always carried through a sign-in: a People search with a space in it is
// written `q=a+b`. Neither changes where a browser goes: each is an ordinary
// character of a path or a query to it, and the slash rule above still holds.
//
// One rule, here, for every route that redirects after signing somebody in:
// the SSO exchange in the core and the OIDC flow in packages/ee.
export const SAFE_NEXT = /^\/(?!\/)[\w\-./?=&%#+*]*$/;

export const MAX_NEXT = 512;

// The path when it is one, and undefined for anything else: nothing given,
// not a string, too long, or not a path of this dashboard.
export function safeNextPath(next: unknown): string | undefined {
  return typeof next === 'string' && next.length <= MAX_NEXT && SAFE_NEXT.test(next)
    ? next
    : undefined;
}
