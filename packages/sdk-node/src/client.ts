import { signUserId } from './sign.js';

// createClient: track and identify from an application's own server, queued,
// batched per person and retried, so a call site never waits on analytics and
// never has to handle it failing.
//
// What the queue is shaped by is the route it posts to, POST
// /api/sites/:siteId/events with a key carrying write:events:
//
// - one userId, and optionally one visitorId, per request, with 1 to 50 events.
//   So the queue is grouped by person on the way out.
// - the server clamps an event's time to between 24 hours before arrival and
//   arrival. So an event carries the moment it was tracked, and nothing holds
//   one for long: a request gives up after about sixteen seconds of waiting.
// - the route validates the whole batch, so one event outside its limits fails
//   the other 49. So every event is checked against the same limits when it is
//   tracked, and one that would fail is dropped there, alone, and reported.
//
// A server event needs no signature: the key is the proof that a browser's
// signed identify stands in for. signUserId is for the page, not for this.

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

// What a caller may hand in as properties or traits. The route stores strings,
// so a number or a boolean is written as one, and an empty value is left out,
// the same way the browser tracker treats them.
export type ChokhAttributes = Record<string, string | number | boolean | null | undefined>;

export interface TrackOptions {
  props?: ChokhAttributes;
  // A number the reports can sum, an order total for example.
  value?: number;
  // The page the fact is about, when there is one.
  path?: string;
  // When it happened, in Unix milliseconds. Defaults to the moment of the call.
  // The server moves anything older than 24 hours to 24 hours ago.
  ts?: number;
  // The browser's visitor id when the application knows it: the event then
  // joins the stay that person is in the middle of.
  visitorId?: string;
}

export interface IdentifyOptions {
  path?: string;
  ts?: number;
  visitorId?: string;
}

export interface ChokhSendResult {
  accepted: number;
  visitorId: string;
}

export interface ChokhBatch {
  userId: string;
  visitorId?: string;
  events: ChokhEvent[];
}

export class ChokhError extends Error {
  readonly code: string;
  // The HTTP status, or 0 when no answer arrived at all.
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ChokhError';
    this.code = code;
    this.status = status;
  }
}

// Why events left the queue without being stored.
//
// invalid            outside the route's limits, found when tracked
// queue_full         the queue was at maxQueueSize, so its oldest made room
// rejected           the server answered 4xx; sending again cannot succeed
// retries_exhausted  a network error or a 5xx on every attempt
// shutdown           still queued, or still retrying, when shutdown ran out of time
export type DropReason = 'invalid' | 'queue_full' | 'rejected' | 'retries_exhausted' | 'shutdown';

export interface QueuedEvent {
  userId: string;
  visitorId?: string;
  event: ChokhEvent;
}

export interface ChokhDrop {
  reason: DropReason;
  events: QueuedEvent[];
  // Why, in a sentence: the limit an invalid event broke, or the last error.
  message: string;
  error?: ChokhError;
}

export interface FlushResult {
  // Events the server accepted, and events dropped, during this flush.
  sent: number;
  dropped: number;
}

export interface ChokhClientOptions {
  // The Chokh server's origin, for example https://analytics.example.com.
  url: string;
  siteId: string;
  // A key carrying write:events. A credential: it belongs in the environment,
  // never in a page.
  apiKey: string;
  // Called once for every group of events that left the queue unstored. The
  // default writes one console.warn line. Nothing a tracking call does throws.
  onDrop?: (drop: ChokhDrop) => void;
  // How long one request may take before it counts as a network error.
  timeoutMs?: number;
  // A flush starts when this many events are queued...
  flushAt?: number;
  // ...or this long after the first of them was, whichever comes first.
  flushIntervalMs?: number;
  // At most this many events wait; a full queue drops its oldest.
  maxQueueSize?: number;
  // Retries after the first attempt, on a network error or a 5xx only.
  maxRetries?: number;
  // The backoff ceiling starts here and doubles per retry, up to retryMaxMs;
  // each wait is a random time below it ("full jitter").
  retryBaseMs?: number;
  retryMaxMs?: number;
  // How long shutdown() keeps sending before it drops what is left.
  shutdownTimeoutMs?: number;
  // Send what is queued when the process's event loop runs dry. No signal
  // handler is installed: see the README for SIGTERM.
  flushOnExit?: boolean;
  // Injected for tests and for a runtime whose fetch is elsewhere.
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface ChokhClient {
  // A fact about somebody the application is sure of. Queued; returns at once.
  track(userId: string, name: string, options?: TrackOptions): void;
  // The same person, named, with optional traits. Queued; returns at once.
  identify(userId: string, traits?: ChokhAttributes, options?: IdentifyOptions): void;
  // Send everything queued now. Resolves when the queue is empty (or every
  // event in it has been dropped); never rejects.
  flush(): Promise<FlushResult>;
  // flush() within shutdownTimeoutMs, then drop the rest and refuse new events.
  shutdown(): Promise<FlushResult>;
  // Events waiting to be sent, not counting a request in flight.
  pending(): number;
  // One request now, outside the queue, with no retry: resolves with the
  // visitor the events landed on, or rejects with a ChokhError.
  send(batch: ChokhBatch): Promise<ChokhSendResult>;
  // The signature a page passes as the fourth argument of pa('identify'),
  // from the site's identifySecret.
  signUserId(identifySecret: string, userId: string): string;
}

// The route's limits, mirrored from packages/server/src/schemas/events.schema.ts.
// The server is the authority; these exist so a bad event is refused alone.
export const LIMITS = {
  idLength: 200,
  nameLength: 120,
  pathLength: 1024,
  attributes: 40,
  attributeKeyLength: 64,
  attributeValueLength: 512,
  eventsPerRequest: 50,
} as const;

export const DEFAULTS = {
  timeoutMs: 5_000,
  flushAt: 20,
  flushIntervalMs: 1_000,
  maxQueueSize: 1_000,
  maxRetries: 5,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
  shutdownTimeoutMs: 5_000,
} as const;

interface Envelope {
  success?: boolean;
  data?: ChokhSendResult;
  error?: { code?: string; message?: string };
}

function attributes(
  input: ChokhAttributes,
  what: 'property' | 'trait',
): Record<string, string> | string {
  const out: Record<string, string> = {};
  let count = 0;
  for (const key of Object.keys(input)) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (key.length === 0 || key.length > LIMITS.attributeKeyLength) {
      return `${what} name "${key.slice(0, 80)}" is not 1 to ${LIMITS.attributeKeyLength} characters`;
    }
    const value = String(raw);
    if (value.length > LIMITS.attributeValueLength) {
      return `${what} "${key}" is longer than ${LIMITS.attributeValueLength} characters`;
    }
    out[key] = value;
    count += 1;
  }
  if (count > LIMITS.attributes) {
    return `more than ${LIMITS.attributes} ${what === 'property' ? 'properties' : 'traits'}`;
  }
  return out;
}

function checkId(value: unknown, what: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.idLength) {
    return `${what} is not a string of 1 to ${LIMITS.idLength} characters`;
  }
  return undefined;
}

function defaultOnDrop(drop: ChokhDrop): void {
  console.warn(
    `chokh: dropped ${drop.events.length} event${drop.events.length === 1 ? '' : 's'} (${drop.reason}): ${drop.message}`,
  );
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function groupKey(item: QueuedEvent): string {
  return `${item.userId}\n${item.visitorId ?? ''}`;
}

export function createClient(options: ChokhClientOptions): ChokhClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `${options.url.replace(/\/+$/, '')}/api/sites/${encodeURIComponent(options.siteId)}/events`;
  const onDrop = options.onDrop ?? defaultOnDrop;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const flushAt = Math.max(1, options.flushAt ?? DEFAULTS.flushAt);
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
  const maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULTS.maxQueueSize);
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULTS.maxRetries);
  const retryBaseMs = options.retryBaseMs ?? DEFAULTS.retryBaseMs;
  const retryMaxMs = options.retryMaxMs ?? DEFAULTS.retryMaxMs;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs;

  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;
  let closed = false;
  // Counted from the moment a flush is asked for, so a flush reports what
  // happened while it was running, including events another caller queued.
  let sentTotal = 0;
  let droppedTotal = 0;
  // Ends every wait and every request in flight once shutdown has run out of
  // time; a fresh one per shutdown.
  let abandon: AbortController | undefined;

  function drop(reason: DropReason, events: QueuedEvent[], message: string, error?: ChokhError): void {
    if (events.length === 0) return;
    droppedTotal += events.length;
    try {
      onDrop(error === undefined ? { reason, events, message } : { reason, events, message, error });
    } catch {
      // A reporter that throws must not take the queue down with it.
    }
  }

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function enqueue(item: QueuedEvent): void {
    if (closed) {
      drop('shutdown', [item], 'the client was shut down');
      return;
    }
    if (queue.length >= maxQueueSize) {
      const oldest = queue.shift();
      if (oldest !== undefined) {
        drop('queue_full', [oldest], `the queue holds at most ${maxQueueSize} events`);
      }
    }
    queue.push(item);
    if (queue.length >= flushAt) {
      void flush();
    } else if (timer === undefined && draining === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, flushIntervalMs);
      timer.unref?.();
    }
  }

  // The next request: the oldest event's person, and every other queued event
  // of that same person up to the route's 50, in the order they were tracked.
  function takeGroup(): QueuedEvent[] {
    const first = queue[0];
    if (first === undefined) return [];
    const key = groupKey(first);
    const group: QueuedEvent[] = [];
    const rest: QueuedEvent[] = [];
    for (const item of queue) {
      if (group.length < LIMITS.eventsPerRequest && groupKey(item) === key) {
        group.push(item);
      } else {
        rest.push(item);
      }
    }
    queue = rest;
    return group;
  }

  function bodyOf(group: QueuedEvent[]): ChokhBatch {
    const first = group[0] as QueuedEvent;
    return {
      userId: first.userId,
      ...(first.visitorId === undefined ? {} : { visitorId: first.visitorId }),
      events: group.map((item) => item.event),
    };
  }

  // One POST. Resolves with the envelope's data, or rejects with a ChokhError
  // whose status is 0 when nothing answered.
  async function post(batch: ChokhBatch, signal?: AbortSignal): Promise<ChokhSendResult> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(batch),
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ChokhError('NETWORK_ERROR', `No answer from ${endpoint}: ${message}`, 0);
    }
    let envelope: Envelope = {};
    try {
      envelope = (await response.json()) as Envelope;
    } catch {
      // A proxy's HTML error page, or an empty body. The status says enough.
    }
    if (!response.ok || envelope.success !== true || envelope.data === undefined) {
      throw new ChokhError(
        envelope.error?.code ?? 'REQUEST_FAILED',
        envelope.error?.message ?? `The server answered ${response.status}`,
        response.status,
      );
    }
    return envelope.data;
  }

  function retryable(error: ChokhError): boolean {
    return error.status === 0 || error.status >= 500;
  }

  // Read through a function so a check after an await sees the current answer.
  function abandoned(): boolean {
    return abandon?.signal.aborted ?? false;
  }

  // A wait that ends early when shutdown gives up.
  function wait(ms: number): Promise<void> {
    const signal = abandon?.signal;
    if (signal === undefined) return sleep(ms);
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done);
      void sleep(ms).then(done);
    });
  }

  async function deliver(group: QueuedEvent[]): Promise<void> {
    const batch = bodyOf(group);
    for (let attempt = 0; ; attempt += 1) {
      if (abandoned()) {
        drop('shutdown', group, 'shutdown ran out of time while this request was retrying');
        return;
      }
      try {
        const result = await post(batch, abandon?.signal);
        sentTotal += result.accepted;
        return;
      } catch (caught) {
        const error = caught instanceof ChokhError ? caught : new ChokhError('REQUEST_FAILED', String(caught), 0);
        if (abandoned()) {
          drop('shutdown', group, 'shutdown ran out of time while this request was in flight', error);
          return;
        }
        if (!retryable(error)) {
          drop('rejected', group, `${error.code}: ${error.message}`, error);
          return;
        }
        if (attempt >= maxRetries) {
          drop('retries_exhausted', group, `${attempt + 1} attempts, the last: ${error.message}`, error);
          return;
        }
        const ceiling = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt);
        await wait(Math.floor(random() * ceiling));
      }
    }
  }

  function drain(): Promise<void> {
    if (draining === undefined) {
      clearTimer();
      draining = (async () => {
        try {
          for (let group = takeGroup(); group.length > 0; group = takeGroup()) {
            await deliver(group);
          }
        } finally {
          draining = undefined;
        }
      })();
    }
    return draining;
  }

  async function flush(): Promise<FlushResult> {
    const sentBefore = sentTotal;
    const droppedBefore = droppedTotal;
    // A drain already running took its groups before this call; anything
    // queued since is picked up by the same loop, and the loop is awaited
    // until the queue is empty.
    while (draining !== undefined || queue.length > 0) {
      await drain();
    }
    return { sent: sentTotal - sentBefore, dropped: droppedTotal - droppedBefore };
  }

  function onBeforeExit(): void {
    if (queue.length > 0 && draining === undefined) {
      void flush();
    }
  }
  const watchExit = options.flushOnExit !== false && typeof process !== 'undefined' && typeof process.on === 'function';
  if (watchExit) {
    process.on('beforeExit', onBeforeExit);
  }

  async function shutdown(): Promise<FlushResult> {
    const sentBefore = sentTotal;
    const droppedBefore = droppedTotal;
    closed = true;
    clearTimer();
    if (watchExit) {
      process.off('beforeExit', onBeforeExit);
    }
    abandon = new AbortController();
    const controller = abandon;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const outOfTime = new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        controller.abort();
        resolve();
      }, shutdownTimeoutMs);
      deadline.unref?.();
    });
    await Promise.race([flush(), outOfTime]);
    if (deadline !== undefined) clearTimeout(deadline);
    controller.abort();
    // A request still in flight is aborted and reports itself; anything never
    // sent is dropped here.
    if (draining !== undefined) await draining;
    const left = queue;
    queue = [];
    drop('shutdown', left, `shutdown ran out of time after ${shutdownTimeoutMs} ms`);
    return { sent: sentTotal - sentBefore, dropped: droppedTotal - droppedBefore };
  }

  return {
    track(userId, name, eventOptions = {}) {
      const item: QueuedEvent = { userId, event: { type: 'event', name } };
      const problem =
        checkId(userId, 'userId') ??
        (eventOptions.visitorId === undefined ? undefined : checkId(eventOptions.visitorId, 'visitorId')) ??
        (typeof name !== 'string' || name.length === 0 || name.length > LIMITS.nameLength
          ? `the event name is not 1 to ${LIMITS.nameLength} characters`
          : undefined) ??
        (eventOptions.path !== undefined && eventOptions.path.length > LIMITS.pathLength
          ? `the path is longer than ${LIMITS.pathLength} characters`
          : undefined) ??
        (eventOptions.value !== undefined && !Number.isFinite(eventOptions.value)
          ? 'the value is not a finite number'
          : undefined) ??
        (eventOptions.ts !== undefined && !Number.isInteger(eventOptions.ts)
          ? 'ts is not an integer number of milliseconds'
          : undefined);
      if (eventOptions.visitorId !== undefined) item.visitorId = eventOptions.visitorId;
      if (problem !== undefined) {
        drop('invalid', [item], problem);
        return;
      }
      item.event.ts = eventOptions.ts ?? now();
      if (eventOptions.path !== undefined) item.event.path = eventOptions.path;
      if (eventOptions.value !== undefined) item.event.value = eventOptions.value;
      if (eventOptions.props !== undefined) {
        const props = attributes(eventOptions.props, 'property');
        if (typeof props === 'string') {
          drop('invalid', [item], props);
          return;
        }
        if (Object.keys(props).length > 0) item.event.props = props;
      }
      enqueue(item);
    },

    identify(userId, traits, identifyOptions = {}) {
      const item: QueuedEvent = { userId, event: { type: 'identify' } };
      if (identifyOptions.visitorId !== undefined) item.visitorId = identifyOptions.visitorId;
      const problem =
        checkId(userId, 'userId') ??
        (identifyOptions.visitorId === undefined ? undefined : checkId(identifyOptions.visitorId, 'visitorId')) ??
        (identifyOptions.path !== undefined && identifyOptions.path.length > LIMITS.pathLength
          ? `the path is longer than ${LIMITS.pathLength} characters`
          : undefined) ??
        (identifyOptions.ts !== undefined && !Number.isInteger(identifyOptions.ts)
          ? 'ts is not an integer number of milliseconds'
          : undefined);
      if (problem !== undefined) {
        drop('invalid', [item], problem);
        return;
      }
      item.event.ts = identifyOptions.ts ?? now();
      if (identifyOptions.path !== undefined) item.event.path = identifyOptions.path;
      if (traits !== undefined) {
        const checked = attributes(traits, 'trait');
        if (typeof checked === 'string') {
          drop('invalid', [item], checked);
          return;
        }
        if (Object.keys(checked).length > 0) item.event.traits = checked;
      }
      enqueue(item);
    },

    flush,
    shutdown,

    pending() {
      return queue.length;
    },

    send(batch) {
      return post(batch);
    },

    signUserId(identifySecret, userId) {
      return signUserId(identifySecret, options.siteId, userId);
    },
  };
}
