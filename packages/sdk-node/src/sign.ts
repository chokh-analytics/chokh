import { createHmac } from 'node:crypto';

// The formula, in one line, so a server in another language can issue the same
// signature from this description alone:
//
//   base64url(hmac_sha256(identifySecret, siteId + "\n" + userId))
//
// The site is in the signed string so a signature issued for one site cannot be
// replayed at another. The secret never reaches a browser: one that could read it
// could sign anything.
export function signUserId(identifySecret: string, siteId: string, userId: string): string {
  return createHmac('sha256', identifySecret).update(`${siteId}\n${userId}`).digest('base64url');
}

// The other signature, for the other half of a first-party setup: a proxy on
// your own domain that forwards the tracker's beacon to the collector.
//
// That proxy is the peer the collector sees, so without this every visitor of
// your site is stored as the proxy: one address, one country, one cookieless
// visitor id for everybody. The proxy therefore carries the visitor's address
// across and signs it, because a header anybody can set is an address anybody
// can claim. The collector reads the pair only in its x-chokh-forwarded-for
// mode, and falls back to the peer chain whenever the signature does not check
// out, so a beacon is never refused over one.
//
// Two headers, and the signature carries the instant it was made so the
// collector knows which one to check. In a Node proxy that is:
//
//   const ts = Date.now();
//   headers.set('X-Chokh-Forwarded-For', ip);
//   headers.set('X-Chokh-Forwarded-Sig', `${ts}.${signForwardedAddress(secret, ip, ts)}`);
//
// The collector believes a ts within 120 seconds of arrival, so a header read
// out of a log is worth nothing two minutes later. The formula, in one line, so
// a proxy in another language can issue the same signature from this
// description alone:
//
//   base64url(hmac_sha256(CHOKH_PROXY_SECRET, address + "\n" + ts))
//
// ts is the Unix time in milliseconds. The secret is the collector's
// CHOKH_PROXY_SECRET and never reaches a browser: one that could read it could
// claim any address.
export function signForwardedAddress(proxySecret: string, ip: string, ts: number): string {
  return createHmac('sha256', proxySecret).update(`${ip}\n${ts}`).digest('base64url');
}
