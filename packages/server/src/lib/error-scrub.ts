// What a captured JavaScript error keeps (AN-VIT01). The message, the frame and
// the stack are text a page's own script wrote, so anything in them could name
// a person or open an account: an address in a validation message, a token in
// a URL a fetch failed on, a user id in a route. Each is scrubbed here, before
// the row exists, so nothing below the collector ever holds the original, and
// the error report can be read with read:stats the way a page path is.
//
// What goes: the query string and fragment of anything that looks like a URL or
// a path (the part that carries tokens and ids, while the path names the
// page); email addresses; JWTs; UUIDs; any run of 24 or more letters, digits,
// dashes and underscores that has a digit in it (API keys, session ids, object
// ids, hashes); runs of nine or more digits (phone and card numbers, long
// ids); the value after anything named like a secret (token=, key:,
// password=, and so on); and whatever follows Bearer. What stays is the shape
// of the message, which is also what makes two errors from two people the
// same group.

export const ERROR_MESSAGE_MAX = 200;
export const ERROR_FRAME_MAX = 300;
export const ERROR_STACK_MAX = 1000;

// The query runs to the next space, quote or bracket, or to the :line:column a
// stack frame puts after a script's URL, which is kept.
const URL_QUERY =
  /((?:[a-z][a-z0-9+.-]*:)?\/\/[^\s?#'"`()<>]*|\/[\w\-./%~:@]*)[?#][^\s'"`()<>]*?(?=:\d+(?::\d+)?(?:[\s'"`()<>]|$)|[\s'"`()<>]|$)/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// A name and then : or =, never a space: "Unexpected token < in JSON" is the
// commonest error there is and names nothing.
const SECRET_PAIR =
  /\b((?:access[_-]?|refresh[_-]?|id[_-]?|auth[_-]?|api[_-]?|session[_-]?|csrf[_-]?)?(?:token|key|secret|password|passwd|pwd|sig|signature|otp|authorization))(["']?\s*[:=]\s*)(["']?)(?:Bearer\s+)?[^\s"'&,;)}\]]+/gi;
const BEARER = /\bBearer\s+[\w.~+/=-]+/g;
const LONG_TOKEN = /\b(?=[\w-]*\d)[\w-]{24,}\b/g;
const LONG_NUMBER = /\d(?:[ -]?\d){8,}/g;

export function scrubErrorText(text: string): string {
  return text
    .replace(URL_QUERY, '$1')
    .replace(EMAIL, '[email]')
    .replace(JWT, '[token]')
    .replace(UUID, '[id]')
    .replace(
      SECRET_PAIR,
      (_match, name: string, separator: string, quote: string) =>
        `${name}${separator}${quote}[redacted]`,
    )
    .replace(BEARER, 'Bearer [redacted]')
    .replace(LONG_TOKEN, '[token]')
    .replace(LONG_NUMBER, '[number]');
}

// Scrubbed, then cut, so a cut never leaves half a token behind it.
export function scrubbedErrorField(text: string, max: number): string {
  return scrubErrorText(text).slice(0, max);
}

// An error row's path: the page, with no query string or fragment at all,
// whatever the site's own exclusions say.
export function errorPath(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}
