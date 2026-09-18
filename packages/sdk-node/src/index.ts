import { createHmac } from 'node:crypto';

// @chokh/sdk-node: what an application's own server needs from Chokh.
//
// Two jobs, and they are separate on purpose.
//
// The two signing lines are the ones that cannot live anywhere else. A page
// calling pa('identify', userId) can claim to be anybody, so a site whose
// administrators can then read that person's addresses and pages signs the userId
// on its server and hands the page the signature; and a first-party proxy in front
// of the collector is the peer it sees, so the proxy signs the visitor's address
// it forwards. signUserId and signForwardedAddress are the lines that make those,
// and they are here rather than imported from the collector because a product must
// not depend on its own client SDK: the server verifies, this signs, and a shared
// test vector in both packages is what stops each pair drifting apart.
//
// createClient is the thin half: track and identify over fetch, for facts a
// backend knows and a browser either cannot see or cannot be trusted about. No
// batching, no retries, no queue; AN-SDK01 owns those, along with publishing this
// package and the react and next wrappers.

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

export type ChokhEventType = 'event' | 'identify';

export interface ChokhEvent {
  type: ChokhEventType;
  // Required for an event, meaningless for an identify.
  name?: string;
  ts?: number;
  path?: string;
  props?: Record<string, string>;
  traits?: Record<string, string>;
  value?: number;
}

export interface ChokhClientOptions {
  // The collector's origin, for example https://analytics.example.com.
  url: string;
  siteId: string;
  // A key carrying write:events. It is a credential, so it belongs in the
  // environment and never in a page.
  apiKey: string;
  // Injected for tests and for a runtime whose global fetch is somewhere else.
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ChokhSendResult {
  accepted: number;
  visitorId: string;
}

// The envelope every Chokh route answers with. Declared here so a consumer of
// this package does not have to.
interface ChokhEnvelope {
  success: boolean;
  data?: ChokhSendResult;
  error?: { code: string; message: string };
}

export class ChokhError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ChokhError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

export interface ChokhClient {
  // A fact about somebody the application is sure of.
  track(userId: string, name: string, event?: Omit<ChokhEvent, 'type' | 'name'>): Promise<ChokhSendResult>;
  // The same person, named, with optional traits.
  identify(userId: string, traits?: Record<string, string>): Promise<ChokhSendResult>;
  // The signature a page passes as the fourth argument of pa('identify'). Needs
  // the site's identifySecret, which the create response showed once.
  signUserId(identifySecret: string, userId: string): string;
  send(batch: { userId: string; visitorId?: string; events: ChokhEvent[] }): Promise<ChokhSendResult>;
}

export function createClient(options: ChokhClientOptions): ChokhClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `${options.url.replace(/\/+$/, '')}/api/sites/${encodeURIComponent(options.siteId)}/events`;

  async function send(batch: {
    userId: string;
    visitorId?: string;
    events: ChokhEvent[];
  }): Promise<ChokhSendResult> {
    // A timeout, because analytics must never be the reason a checkout hangs. A
    // caller who cannot afford even this should not await the promise.
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const envelope = (await response.json()) as ChokhEnvelope;
    if (!response.ok || envelope.success !== true || envelope.data === undefined) {
      throw new ChokhError(
        envelope.error?.code ?? 'REQUEST_FAILED',
        envelope.error?.message ?? `The collector answered ${response.status}`,
        response.status,
      );
    }
    return envelope.data;
  }

  return {
    send,

    track(userId, name, event = {}) {
      return send({ userId, events: [{ ...event, type: 'event', name }] });
    },

    identify(userId, traits) {
      return send({
        userId,
        events: [{ type: 'identify', ...(traits === undefined ? {} : { traits }) }],
      });
    },

    signUserId(identifySecret, userId) {
      return signUserId(identifySecret, options.siteId, userId);
    },
  };
}
