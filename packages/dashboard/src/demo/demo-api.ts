import { answer, REALTIME_FRAME } from '../../e2e/fixture-answers.mjs';

// The demo's API, in the page itself.
//
// The demo is the dashboard as built, over the frozen fixture the README's
// pictures are taken from, served as static files with no server behind
// them. So every request the dashboard makes to /api is answered here,
// before it leaves the page: `fetch` and `EventSource` are replaced, for
// /api only, with ones that ask fixture-answers.mjs. Not a service worker,
// on purpose: Firefox's private windows have none, and a first load would
// race the worker before it controlled the page. This is in place before a
// single module of the dashboard runs, in every browser, on the first load.
//
// Nothing is stored and nothing can be changed. A read is answered as an
// install with a licence key would answer it; anything else is refused in
// the envelope, which the dashboard shows as it shows any refusal.

const READ_ONLY = {
  success: false,
  error: {
    code: 'DEMO_READ_ONLY',
    message: 'This is a demo with invented data: nothing here can be changed.',
  },
};

function apiPath(input: RequestInfo | URL): URL | null {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, window.location.href);
  return url.origin === window.location.origin && url.pathname.startsWith('/api/') ? url : null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// One frame of who is here, then held open, as the fixture server does.
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    window.setTimeout(() => {
      if (this.readyState === 2) {
        return;
      }
      this.readyState = 1;
      const opened = new Event('open');
      this.onopen?.(opened);
      this.dispatchEvent(opened);
      const message = new MessageEvent('message', { data: JSON.stringify(REALTIME_FRAME) });
      this.onmessage?.(message);
      this.dispatchEvent(message);
    }, 0);
  }

  close(): void {
    this.readyState = 2;
  }
}

export function installDemoApi(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = apiPath(input);
    if (url === null) {
      return realFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return json(403, READ_ONLY);
    }
    const found = answer(url.pathname, url.searchParams, { licensed: true });
    return json(found.status, found.body);
  };
  (window as unknown as { EventSource: unknown }).EventSource = DemoEventSource;
}
