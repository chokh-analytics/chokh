import { createHmac } from 'node:crypto';

// @chokh/sdk-node: what an application's own server needs from Chokh.
//
// Two jobs, and they are separate on purpose.
//
// signUserId is the one that cannot live anywhere else. A page calling
// pa('identify', userId) can claim to be anybody, so a site whose administrators
// can then read that person's addresses and pages signs the userId on its server
// and hands the page the signature. This is the line that makes it, and it is here
// rather than imported from the collector because a product must not depend on its
// own client SDK: the server verifies, this signs, and a shared test vector in both
// packages is what stops the two drifting apart.
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
