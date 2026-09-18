import { createHmac, timingSafeEqual } from 'node:crypto';

// Proof that the first-party proxy in front of this collector, and not a
// stranger, said where a visitor came from.
//
// A site that serves the tracker and the collect path from its own domain puts
// a proxy in the middle: a Vercel route handler, a Cloudflare Worker, a Next or
// Nuxt server. That proxy is then the peer this collector sees, so every
// visitor would be stored as the proxy and one address would own the whole
// site. The proxy therefore carries the visitor's address across in a header
// pair, and signs it, because a header anybody can set is an address anybody
// can claim.
//
// TRUST_PROXY is not the answer here. The proxy is somebody else's
// infrastructure with an address range that changes without notice, and the hop
// in front of it (Cloudflare, Nginx) is trusted already. The signature is the
// trust, and it is the only thing that is.
//
// The signed string is the address and the instant it was signed, joined by a
// newline, and the instant has to be recent, so a header read out of a log is
// worth nothing two minutes later. The formula is one line on purpose, so a
// proxy in any language can issue the same signature from the description
// alone:
//
//   base64url(hmac_sha256(CHOKH_PROXY_SECRET, address + "\n" + ts))
//
// ts is the Unix time in milliseconds, and it travels in front of the signature
// so the collector knows which one to check:
//
//   X-Chokh-Forwarded-For: 103.87.12.45
//   X-Chokh-Forwarded-Sig: 1758268800000.<the base64url signature>
//
// @chokh/sdk-node carries the same one line as signForwardedAddress, because
// that is where a proxy in Node calls it, and this server does not import it: a
// product depending on its own client SDK is the wrong direction. A shared test
// vector asserted in both packages is what stops the two copies drifting apart.

// A beacon is fire and forget, so nothing here ever refuses a request. An
// address that does not check out is simply not believed, and the peer chain is
// used instead.
export const FORWARDED_MAX_AGE_MS = 120_000;

export function signForwardedAddress(secret: string, ip: string, ts: number): string {
  return createHmac('sha256', secret).update(`${ip}\n${ts}`).digest('base64url');
}

// Digits only, and no spelling but the canonical one: a ts of "0123" would be
// signed here as "123" and would let one header value carry two signatures.
const TS = /^[0-9]{1,15}$/;

export function verifyForwardedAddress(
  secret: string | undefined,
  ip: string,
  signature: string,
  now: number,
): boolean {
  if (secret === undefined || secret === '' || ip === '') {
    return false;
  }
  const dot = signature.indexOf('.');
  if (dot === -1) {
    return false;
  }
  const stamp = signature.slice(0, dot);
  const given = signature.slice(dot + 1);
  if (!TS.test(stamp) || given === '') {
    return false;
  }
  const ts = Number(stamp);
  // A proxy whose clock is a little ahead is as ordinary as one a little
  // behind, so the window is either side of the moment the request arrived.
  if (String(ts) !== stamp || Math.abs(now - ts) > FORWARDED_MAX_AGE_MS) {
    return false;
  }
  const expected = Buffer.from(signForwardedAddress(secret, ip, ts));
  const offered = Buffer.from(given);
  // Compared in constant time, for the same reason the identify signature is:
  // a check that leaks how far it got is a check somebody can walk through one
  // character at a time.
  return expected.length === offered.length && timingSafeEqual(expected, offered);
}
