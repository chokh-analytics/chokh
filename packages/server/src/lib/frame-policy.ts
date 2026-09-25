// Who may put a dashboard page in a frame (AN-RPT01).
//
// Nobody, except for the one page that exists to be framed: the share's
// embed, which a site puts in an iframe of its own. Everything else, the
// signed-in dashboard above all, answers frame-ancestors 'none', which is the
// clickjacking answer, and the older header beside it for a browser that
// reads only that one.

const EMBED_PATH = /^\/share\/[^/?#]+\/embed(?:[/?#]|$)/;

export function framePolicy(url: string): Record<string, string> {
  return EMBED_PATH.test(url)
    ? { 'content-security-policy': 'frame-ancestors *' }
    : { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' };
}
