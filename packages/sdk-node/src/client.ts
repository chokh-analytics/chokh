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
  // How long the server asked us to wait (a Retry-After header), when it did.
  readonly retryAfterMs: number | undefined;

  constructor(code: string, message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'ChokhError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
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
  // At most this many requests in flight at once, never two for one person
  // (one userId and visitorId), so each person's events arrive in order.
  concurrency?: number;
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
  // One request at a time delivers at most one person per round trip: 20 a
  // second at 50 ms, past which a healthy server's queue fills and drops. Four
  // lifts that to 80 requests a second of up to 50 events each, more than an
  // application's own backend usually sends, while a Chokh server sees at most
  // four connections from each process that uses this.
  concurrency: 4,
} as const;

interface Envelope {
  success?: boolean;
  data?: ChokhSendResult;
  error?: { code?: string; message?: string };
}

// The checks below are for callers TypeScript does not reach: a CommonJS or
// plain JavaScript caller can pass anything, and a value of the wrong type that
// got past here would fail the whole request it rides in at the server.
function attributes(
  input: unknown,
  what: 'property' | 'trait',
): Record<string, string> | string {
  const plural = what === 'property' ? 'properties' : 'traits';
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return `the ${plural} are not an object`;
  }
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      return `${what} "${key.slice(0, 80)}" is not a string, a number or a boolean`;
    }
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
    return `more than ${LIMITS.attributes} ${plural}`;
  }
  return out;
}

function checkPath(path: unknown): string | undefined {
  if (path === undefined) return undefined;
  if (typeof path !== 'string' || path.length > LIMITS.pathLength) {
    return `the path is not a string of at most ${LIMITS.pathLength} characters`;
  }
  return undefined;
}

function checkTs(ts: unknown): string | undefined {
  return ts === undefined || Number.isInteger(ts) ? undefined : 'ts is not an integer number of milliseconds';
}

// How long a Retry-After header asks for, in milliseconds: delay-seconds or an
// HTTP date. Unreadable or absent is undefined.
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
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
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULTS.concurrency));

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
  let stopping: Promise<FlushResult> | undefined;
  // The people with a request in flight, and how many requests that is.
  const inFlight = new Set<string>();
  let active = 0;
  let settle: (() => void) | undefined;

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
    if (draining !== undefined) {
      // A drain is running: a free slot takes this person now rather than
      // waiting for a slow one to finish.
      pump();
    } else if (queue.length >= flushAt) {
      void flush();
    } else if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, flushIntervalMs);
      timer.unref?.();
    }
  }

  // The next request: the oldest queued event of a person with no request in
  // flight, and every other queued event of that person up to the route's 50,
  // in the order they were tracked. A person already in flight waits for their
  // own request to finish, so their events arrive in order.
  function takeGroup(): QueuedEvent[] {
    const first = queue.find((item) => !inFlight.has(groupKey(item)));
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
        retryAfterMs(response.headers.get('retry-after'), now()),
      );
    }
    return envelope.data;
  }

  // Worth sending again: no answer, a 5xx, and the two 4xx that mean "again
  // later", 408 (the request took too long) and 429 (too many). The route
  // itself sends neither, but a proxy in front of a Chokh server can.
  function retryable(error: ChokhError): boolean {
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
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
        // A Retry-After is honoured, up to retryMaxMs; otherwise full jitter.
        const ceiling = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt);
        await wait(
          error.retryAfterMs === undefined
            ? Math.floor(random() * ceiling)
            : Math.min(retryMaxMs, error.retryAfterMs),
        );
      }
    }
  }

  // Start a request for every free slot that has a person to send: at most
  // `concurrency` at once and never two for one person. Each request, when it
  // ends, frees its slot and its person and starts the next. The drain ends
  // when nothing is in flight, which is when the queue is empty.
  function pump(): void {
    while (active < concurrency) {
      const group = takeGroup();
      const first = group[0];
      if (first === undefined) break;
      const key = groupKey(first);
      inFlight.add(key);
      active += 1;
      void deliver(group)
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(key);
          active -= 1;
          pump();
          if (active === 0) {
            const done = settle;
            settle = undefined;
            draining = undefined;
            done?.();
          }
        });
    }
  }

  function drain(): Promise<void> {
    clearTimer();
    if (draining === undefined) {
      draining = new Promise<void>((resolve) => {
        settle = resolve;
      });
    }
    const current = draining;
    pump();
    if (active === 0 && settle !== undefined) {
      // Nothing to send: the drain ends as it starts.
      const done = settle;
      settle = undefined;
      draining = undefined;
      done();
    }
    return current;
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

  // A second shutdown while one is running joins it, rather than replacing the
  // abandon signal under a request already in flight.
  function shutdown(): Promise<FlushResult> {
    stopping ??= stop();
    return stopping;
  }

  async function stop(): Promise<FlushResult> {
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
    // Both check every argument against the route's limits and types, because a
    // JavaScript caller can pass anything, and a request the server refuses
    // takes up to 49 other events with it. Whatever fails, or throws, becomes
    // an `invalid` drop: neither call ever throws.
    track(userId, name, eventOptions) {
      const item: QueuedEvent = { userId, event: { type: 'event', name } };
      try {
        const options: TrackOptions = eventOptions ?? {};
        if (typeof options !== 'object') {
          drop('invalid', [item], 'the options are not an object');
          return;
        }
        if (typeof options.visitorId === 'string') item.visitorId = options.visitorId;
        const problem =
          checkId(userId, 'userId') ??
          (options.visitorId === undefined ? undefined : checkId(options.visitorId, 'visitorId')) ??
          (typeof name !== 'string' || name.length === 0 || name.length > LIMITS.nameLength
            ? `the event name is not 1 to ${LIMITS.nameLength} characters`
            : undefined) ??
          checkPath(options.path) ??
          (options.value !== undefined && !Number.isFinite(options.value) ? 'the value is not a finite number' : undefined) ??
          checkTs(options.ts);
        if (problem !== undefined) {
          drop('invalid', [item], problem);
          return;
        }
        item.event.ts = options.ts ?? now();
        if (options.path !== undefined) item.event.path = options.path;
        if (options.value !== undefined) item.event.value = options.value;
        if (options.props !== undefined && options.props !== null) {
          const props = attributes(options.props, 'property');
          if (typeof props === 'string') {
            drop('invalid', [item], props);
            return;
          }
          if (Object.keys(props).length > 0) item.event.props = props;
        }
        enqueue(item);
      } catch (error) {
        drop('invalid', [item], `the event could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    identify(userId, traits, identifyOptions) {
      const item: QueuedEvent = { userId, event: { type: 'identify' } };
      try {
        const options: IdentifyOptions = identifyOptions ?? {};
        if (typeof options !== 'object') {
          drop('invalid', [item], 'the options are not an object');
          return;
        }
        if (typeof options.visitorId === 'string') item.visitorId = options.visitorId;
        const problem =
          checkId(userId, 'userId') ??
          (options.visitorId === undefined ? undefined : checkId(options.visitorId, 'visitorId')) ??
          checkPath(options.path) ??
          checkTs(options.ts);
        if (problem !== undefined) {
          drop('invalid', [item], problem);
          return;
        }
        item.event.ts = options.ts ?? now();
        if (options.path !== undefined) item.event.path = options.path;
        if (traits !== undefined && traits !== null) {
          const checked = attributes(traits, 'trait');
          if (typeof checked === 'string') {
            drop('invalid', [item], checked);
            return;
          }
          if (Object.keys(checked).length > 0) item.event.traits = checked;
        }
        enqueue(item);
      } catch (error) {
        drop('invalid', [item], `the identify could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
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
