import type { Batch, Config, Context, TrackedEvent } from './types';

const FLUSH_DELAY_MS = 1000;
const MAX_BATCH = 20;

// sendBeacon only survives a cross-origin hop without a preflight when the body
// is a simple content type, and a beacon cannot be preflighted at all, so the
// collector reads the body as JSON whatever the header says.
const CONTENT_TYPE = 'text/plain;charset=UTF-8';

export interface Queue {
  push(event: TrackedEvent): void;
  flush(): void;
  allow(consented: boolean): void;
  pending(): number;
}

export interface QueueDeps {
  config: Config;
  win: Window;
  context(): Context;
  page(): { hostname: string; lang?: string; screen?: string; viewport?: string };
}

export function send(win: Window, url: string, body: string): void {
  const nav = win.navigator;
  try {
    if (typeof nav.sendBeacon === 'function') {
      const blob = new Blob([body], { type: CONTENT_TYPE });
      if (nav.sendBeacon(url, blob)) {
        return;
      }
    }
  } catch {
    // A beacon can throw when the payload is rejected; fall through to fetch.
  }
  try {
    void win.fetch(url, {
      method: 'POST',
      body,
      keepalive: true,
      credentials: 'omit',
      headers: { 'Content-Type': CONTENT_TYPE },
    }).catch(() => undefined);
  } catch {
    // Nothing left to try. Losing analytics must never break the page.
  }
}

export function createQueue(deps: QueueDeps): Queue {
  const { config, win } = deps;
  let buffer: TrackedEvent[] = [];
  let timer: number | undefined;
  let blocked = config.requireConsent;

  function clearTimer(): void {
    if (timer !== undefined) {
      win.clearTimeout(timer);
      timer = undefined;
    }
  }

  function flush(): void {
    clearTimer();
    if (blocked || buffer.length === 0) {
      return;
    }
    const events = buffer;
    buffer = [];
    const context = deps.context();
    const page = deps.page();
    const batch: Batch = {
      siteId: config.siteId,
      sentAt: Date.now(),
      hostname: page.hostname,
      events,
    };
    if (page.lang !== undefined) batch.lang = page.lang;
    if (page.screen !== undefined) batch.screen = page.screen;
    if (page.viewport !== undefined) batch.viewport = page.viewport;
    if (context.visitorId !== undefined) batch.visitorId = context.visitorId;
    if (context.userId !== undefined) batch.userId = context.userId;
    send(win, config.collectUrl, JSON.stringify(batch));
  }

  return {
    push(event: TrackedEvent): void {
      buffer.push(event);
      if (buffer.length >= MAX_BATCH) {
        flush();
        return;
      }
      if (timer === undefined && !blocked) {
        timer = win.setTimeout(flush, FLUSH_DELAY_MS);
      }
    },
    flush,
    allow(consented: boolean): void {
      blocked = !consented;
      if (consented) {
        flush();
      } else {
        clearTimer();
        buffer = [];
      }
    },
    pending(): number {
      return buffer.length;
    },
  };
}
