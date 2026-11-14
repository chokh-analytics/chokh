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
// One rule, here, for every route that redirects after signing somebody in:
// the SSO exchange in the core and the OIDC flow in packages/ee.
export const SAFE_NEXT = /^\/(?!\/)[\w\-./?=&%#]*$/;

export const MAX_NEXT = 512;

// The path when it is one, and undefined for anything else: nothing given,
// not a string, too long, or not a path of this dashboard.
export function safeNextPath(next: unknown): string | undefined {
  return typeof next === 'string' && next.length <= MAX_NEXT && SAFE_NEXT.test(next)
    ? next
    : undefined;
}
