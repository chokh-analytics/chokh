// The only place in the dashboard that calls fetch.
//
// Everything the API can say is one of two shapes, so everything this file
// returns is one of two shapes: a value with its meta, or a thrown ChokhError
// carrying the code the server used. No page ever reads response.ok, no page
// ever reads a status, and no page has its own idea of what a failure looks
// like.
//
// The client is passed to hooks rather than imported by them, so a component
// test hands in a fake and nothing has to mock a global.

export type Meta = Record<string, unknown>;

export interface Answer<T> {
  data: T;
  meta: Meta | undefined;
}

// What the server said, kept whole. A page that wants to explain a failure
// shows the message; a page that wants to behave differently for one failure
// switches on the code; nothing has to parse English.
export class ChokhError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ChokhError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// A request that never reached a server, or one that answered something that is
// not this API at all. It is a ChokhError so that every caller has one thing to
// catch, with a code nothing on the server can collide with.
export const NETWORK_CODE = 'NETWORK';
export const MALFORMED_CODE = 'MALFORMED_RESPONSE';

export type Params = Record<string, string | number | boolean | undefined>;

export interface ClientOptions {
  // Where the API is. Empty in production, because the dashboard is served by
  // the same process; a dev server points it at the collector.
  baseUrl?: string;
  // Injected so a test can hand in a fake without touching a global.
  fetch?: typeof globalThis.fetch;
  // Called once for every 401, before the error is thrown. This is the whole
  // session expiry story: one place decides that a signed out person goes to
  // the sign in page, rather than every hook noticing.
  onUnauthenticated?: () => void;
}

export interface Client {
  get<T>(path: string, params?: Params): Promise<Answer<T>>;
  post<T>(path: string, body?: unknown): Promise<Answer<T>>;
  delete<T>(path: string): Promise<Answer<T>>;
  // The URL a browser should navigate to for a download or a stream, which is
  // the one case where the answer is not JSON this file parses.
  url(path: string, params?: Params): string;
}

export function toQueryString(params: Params | undefined): string {
  if (params === undefined) {
    return '';
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // Undefined means "not asked", which is not the same as an empty value: a
    // limit of nothing is the server's default, and sending limit= would be a
    // limit of the empty string.
    if (value === undefined) {
      continue;
    }
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export function createClient(options: ClientOptions = {}): Client {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const url = (path: string, params?: Params): string =>
    `${baseUrl}${path}${toQueryString(params)}`;

  async function send<T>(path: string, init: RequestInit, params?: Params): Promise<Answer<T>> {
    let response: Response;
    try {
      response = await doFetch(url(path, params), {
        // Same origin in production, because this dashboard is served by the
        // API. There is no CORS on the server and none is wanted.
        credentials: 'same-origin',
        ...init,
      });
    } catch (cause) {
      throw new ChokhError(0, NETWORK_CODE, 'Could not reach the server.', cause);
    }

    if (response.status === 401) {
      options.onUnauthenticated?.();
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A response that is not JSON is not this API. A proxy error page or a
      // sign in redirect landing here is exactly this, and saying so is more
      // use than a parse error nobody can place.
      throw new ChokhError(
        response.status,
        MALFORMED_CODE,
        'The server answered something that was not an API response.',
      );
    }

    if (typeof body !== 'object' || body === null || !('success' in body)) {
      throw new ChokhError(response.status, MALFORMED_CODE, 'The response carried no envelope.');
    }

    const envelope = body as
      | { success: true; data: T; meta?: Meta }
      | { success: false; error: { code: string; message: string; details?: unknown } };

    if (envelope.success) {
      return { data: envelope.data, meta: envelope.meta };
    }

    throw new ChokhError(
      response.status,
      envelope.error.code,
      envelope.error.message,
      envelope.error.details,
    );
  }

  return {
    get: <T,>(path: string, params?: Params) => send<T>(path, { method: 'GET' }, params),
    post: <T,>(path: string, body?: unknown) =>
      send<T>(path, {
        method: 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    delete: <T,>(path: string) => send<T>(path, { method: 'DELETE' }),
    url,
  };
}

// A paid route, refused. The server answers one status for every reason so that
// a stranger learns nothing from the door; the dashboard is where the
// difference is explained, to somebody who is signed in.
//
// Read as a shape rather than switched on by string at the call site, because
// what a page does with it is always the same: draw the feature, labelled, with
// the reason underneath.
export const LICENSE_REQUIRED_CODE = 'LICENSE_REQUIRED';

export interface LicenseRefusal {
  feature: string;
  reason: string;
}

export function licenseRefusal(error: unknown): LicenseRefusal | null {
  if (!(error instanceof ChokhError) || error.code !== LICENSE_REQUIRED_CODE) {
    return null;
  }
  const details = error.details as { feature?: unknown; reason?: unknown } | null;
  if (typeof details?.feature !== 'string' || typeof details.reason !== 'string') {
    return null;
  }
  return { feature: details.feature, reason: details.reason };
}

// Whether a failure is worth asking about a second time. A 4xx is an answer and
// will be the same answer next time; a network fault or a 5xx might not be.
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ChokhError)) {
    return false;
  }
  return error.status === 0 || error.status >= 500;
}
