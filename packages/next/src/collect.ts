// The first-party collect path, as a route handler:
//
//   // app/%5Fpa/collect/route.ts  (%5F is how a folder whose name starts with _
//   // is written in the App Router: a plain _pa folder is private, never routed)
//   import { createCollectRoute } from '@chokh/next/collect';
//   export const POST = createCollectRoute({
//     url: process.env.NEXT_PUBLIC_CHOKH_URL,
//     proxySecret: process.env.CHOKH_PROXY_SECRET,
//   });
//
// Why a route and not a rewrite: a rewrite is fetched by your host's own
// infrastructure, so the collector's peer would be the host, and every visitor
// would be stored as one machine in one data centre (wrong country, wrong city,
// one cookieless visitor for everybody). This route is the proxy instead, and it
// carries the visitor across: the browser's own headers byte for byte, and the
// visitor's address in X-Chokh-Forwarded-For, signed under CHOKH_PROXY_SECRET in
// X-Chokh-Forwarded-Sig, because a header anybody can set is an address anybody
// can claim. The collector believes the pair only when it runs with
// REAL_IP_HEADER=X-Chokh-Forwarded-For, and falls back to its peer whenever the
// signature does not check out.
//
// Nothing here ever refuses and nothing here ever throws. A beacon cannot read
// an answer, and analytics must never cost a page a request slot: a forward that
// fails answers 202, like one that worked, and the batch is simply lost.
//
// The signature is made with Web Crypto, so the same handler runs on the Node
// and the Edge runtime.

export interface CollectRouteOptions {
  // Your Chokh server's origin. Empty or left out: the route answers 202 and
  // forwards nothing (the tag is not rendered then either).
  url?: string | undefined;
  // The collector's CHOKH_PROXY_SECRET, server side always. Without it the
  // visitor's address is not sent, and the collector sees your host's.
  proxySecret?: string | undefined;
  // How long the collector may take before the beacon is given up on.
  timeoutMs?: number;
  // Injected for tests.
  fetch?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

// The browser headers the collector reads, forwarded byte for byte: origin for
// the site's domain allowlist, user-agent for browser, device and system,
// content-type because the tracker sends text/plain to avoid a preflight. Every
// sec-ch-ua* Client Hint as well, by prefix, because the list grows. A cookie or
// an authorization header never crosses.
const FORWARDED_HEADERS = ['origin', 'user-agent', 'content-type'] as const;
const HINT_PREFIX = 'sec-ch-ua';

// Referer crosses only without an Origin, because the collector reads it only
// then; sending it always would put every page's full URL on every request.
const ORIGIN_FALLBACK = 'referer';

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// base64url(hmac_sha256(CHOKH_PROXY_SECRET, address + "\n" + ts)), the one line
// the collector checks, with ts in Unix milliseconds. The shared test vector in
// @chokh/sdk-node and the server is asserted against this copy too.
export async function signForwardedAddress(secret: string, ip: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(`${ip}\n${ts}`)));
}

// The visitor's address as the host hands it to the function: the first entry
// of x-forwarded-for, else x-real-ip. Empty means unknown, and an unknown
// address is left to the collector rather than guessed.
export function visitorAddress(headers: Headers): string {
  const chain = headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  if (chain !== '') return chain;
  return headers.get('x-real-ip')?.trim() ?? '';
}

function browserHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = from.get(name);
    if (value !== null) headers.set(name, value);
  }
  from.forEach((value, name) => {
    if (name.toLowerCase().startsWith(HINT_PREFIX)) headers.set(name, value);
  });
  if (!headers.has('origin')) {
    const referer = from.get(ORIGIN_FALLBACK);
    if (referer !== null) headers.set(ORIGIN_FALLBACK, referer);
  }
  return headers;
}

export function createCollectRoute(options: CollectRouteOptions): (request: Request) => Promise<Response> {
  const base = (options.url ?? '').trim().replace(/\/+$/, '');
  const collectUrl = base === '' ? '' : `${base}/api/collect`;
  const secret = options.proxySecret ?? '';
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function POST(request: Request): Promise<Response> {
    if (collectUrl === '') return new Response(null, { status: 202 });
    try {
      const body = await request.arrayBuffer();
      const headers = browserHeaders(request.headers);
      const ip = visitorAddress(request.headers);
      if (secret !== '' && ip !== '') {
        const ts = now();
        headers.set('X-Chokh-Forwarded-For', ip);
        headers.set('X-Chokh-Forwarded-Sig', `${ts}.${await signForwardedAddress(secret, ip, ts)}`);
      }
      const answer = await doFetch(collectUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      try {
        // Drained, not passed on: an unread body holds the connection open.
        await answer.arrayBuffer();
      } catch {
        // Nothing to drain, the ordinary case for a 202.
      }
      return new Response(null, { status: answer.status });
    } catch {
      // A timeout, a DNS failure, a collector that is down: the beacon is lost
      // and the page never hears about it.
      return new Response(null, { status: 202 });
    }
  };
}
