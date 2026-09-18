import { createHmac, timingSafeEqual } from 'node:crypto';

// Proof that a site, and not a page, said who somebody is.
//
// A browser can call pa('identify', 'u_someone') with any id it likes, and the
// collector cannot tell a real login from somebody typing into the console. On
// a site whose administrators can then read that person's addresses and pages,
// a forged identify is one visitor reading another's history. So a site that
// cares keeps a secret on its server, signs the userId with it, and hands the
// signature to the page to pass on.
//
// The signed string is the site and the user, joined by a newline, so a
// signature issued for one site cannot be replayed at another. The secret is
// the site's identifySecret and never leaves the server: a browser that could
// read it could sign anything.
//
// @chokh/sdk-node carries the same one line, because that is where an application
// calls it, and this server does not import it: a product depending on its own
// client SDK is the wrong direction, and it would drag a fetch client into the
// image for the sake of one HMAC. A shared test vector asserted in both packages is
// what stops the two copies drifting apart. The formula is one line on purpose, so
// a server in another language can issue the same signature from the description
// alone:
//
//   base64url(hmac_sha256(identifySecret, siteId + "\n" + userId))

export function signUserId(secret: string, siteId: string, userId: string): string {
  return createHmac('sha256', secret).update(`${siteId}\n${userId}`).digest('base64url');
}

export function verifyUserId(
  secret: string | undefined,
  siteId: string,
  userId: string,
  signature: string,
): boolean {
  if (secret === undefined || secret === '' || signature === '') {
    return false;
  }
  const expected = Buffer.from(signUserId(secret, siteId, userId));
  const given = Buffer.from(signature);
  // Compared in constant time, because a signature check that leaks how far it
  // got is a signature check somebody can walk through one character at a time.
  return expected.length === given.length && timingSafeEqual(expected, given);
}
