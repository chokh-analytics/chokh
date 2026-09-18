import { watchClicks } from './autocapture';
import { doNotTrack, findScript, readConfig } from './config';
import { createEngagement } from './engagement';
import { createQueue } from './queue';
import { pagePath, readUtm, watchNavigation } from './router';
import type { Config, Context, Pa, Props, TrackedEvent } from './types';
import { clearVisitorId, readVisitorId, safeStorage } from './visitor';

function asProps(value: unknown): Props | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const props: Props = {};
  let found = false;
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (entry !== undefined && entry !== null) {
      props[key] = String(entry);
      found = true;
    }
  }
  return found ? props : undefined;
}

export function start(win: Window, doc: Document): void {
  const config = readConfig(findScript(doc));
  if (config === null || (config.honourDnt && doNotTrack(win.navigator, win))) {
    // A page whose tag is missing or whose visitor asked not to be tracked
    // still gets the global, so site code calling pa() never throws.
    win.pa = () => undefined;
    return;
  }
  boot(win, doc, config);
}

function boot(win: Window, doc: Document, config: Config): void {
  const loc = win.location;
  const store = config.persistentVisitor ? safeStorage(win) : null;
  const context: Context = {};
  const visitorId = readVisitorId(store, config.siteId);
  if (visitorId !== undefined) {
    context.visitorId = visitorId;
  }

  const screen = win.screen;
  const queue = createQueue({
    config,
    win,
    context: () => context,
    page: () => ({
      hostname: loc.hostname,
      lang: win.navigator.language,
      screen: screen.width + 'x' + screen.height,
      viewport: win.innerWidth + 'x' + win.innerHeight,
    }),
  });

  let path = pagePath(loc, config.hashRouting);
  let referred = false;

  const engagement = createEngagement(win, doc, () => {
    queue.push({ type: 'heartbeat', ts: Date.now(), path });
    queue.flush();
  });

  function pageview(): void {
    path = pagePath(loc, config.hashRouting);
    const event: TrackedEvent = { type: 'pageview', ts: Date.now(), path, title: doc.title };
    const utm = readUtm(loc.search);
    if (utm !== undefined) {
      event.utm = utm;
    }
    if (!referred) {
      referred = true;
      if (doc.referrer !== '') {
        event.referrer = doc.referrer;
      }
    }
    queue.push(event);
    engagement.reset();
  }

  // Closes the page being left, so every page in a single page app carries its
  // own time on page and scroll depth, not just the last one visited.
  function leave(): void {
    queue.push({
      type: 'leave',
      ts: Date.now(),
      path,
      duration: engagement.duration(),
      scrollDepth: engagement.scrollDepth(),
    });
  }

  function track(name: string, props?: Props): void {
    const event: TrackedEvent = { type: 'event', ts: Date.now(), path, name };
    if (props !== undefined) {
      event.props = props;
    }
    queue.push(event);
  }

  function command(name: string, first: unknown, second: unknown): void {
    if (name === 'event' && typeof first === 'string') {
      track(first, asProps(second));
      return;
    }
    if (name === 'identify' && typeof first === 'string') {
      context.userId = first;
      const event: TrackedEvent = { type: 'identify', ts: Date.now(), path, userId: first };
      const traits = asProps(second);
      if (traits !== undefined) {
        event.traits = traits;
      }
      queue.push(event);
      queue.flush();
      return;
    }
    if (name === 'reset') {
      delete context.userId;
      delete context.visitorId;
      if (config.persistentVisitor) {
        clearVisitorId(store, config.siteId);
        const next = readVisitorId(store, config.siteId);
        if (next !== undefined) {
          context.visitorId = next;
        }
      }
      return;
    }
    if (name === 'consent') {
      queue.allow(first === true);
      return;
    }
    if (name === 'vital' && typeof first === 'string') {
      // v.js reports through the same queue, so vitals share the consent gate,
      // the visitor id and the batch with everything else.
      const event: TrackedEvent = { type: 'vital', ts: Date.now(), path, name: first };
      if (typeof second === 'object' && second !== null) {
        const detail = second as { value?: unknown; rating?: unknown };
        if (typeof detail.value === 'number') {
          event.value = detail.value;
        }
        if (typeof detail.rating === 'string') {
          event.rating = detail.rating;
        }
      }
      queue.push(event);
    }
  }

  const previous = win.pa;
  const pa: Pa = (name: string, ...args: unknown[]) => {
    command(name, args[0], args[1]);
  };
  win.pa = pa;

  watchNavigation(win, config.hashRouting, () => {
    if (pagePath(loc, config.hashRouting) !== path) {
      leave();
      pageview();
    }
  });
  watchClicks(doc, loc.hostname, track);

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') {
      queue.flush();
    }
  });

  win.addEventListener('pagehide', () => {
    leave();
    queue.flush();
  });

  engagement.start();
  pageview();

  const queued = previous === undefined ? undefined : previous.q;
  if (queued !== undefined) {
    for (let i = 0; i < queued.length; i++) {
      const args = queued[i];
      if (args !== undefined) {
        command(String(args[0]), args[1], args[2]);
      }
    }
  }
}

