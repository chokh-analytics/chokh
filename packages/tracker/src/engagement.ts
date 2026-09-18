// Time on page and scroll depth for the leave beacon, and the heartbeat that
// makes presence work. Hidden tabs are not counted and do not beat.
export const HEARTBEAT_MS = 20000;

export interface Engagement {
  start(): void;
  reset(): void;
  duration(): number;
  scrollDepth(): number;
}

export function scrollQuartile(win: Window, doc: Document): number {
  const root = doc.documentElement;
  const body = doc.body as HTMLElement | null;
  const height = Math.max(root.scrollHeight, body === null ? 0 : body.scrollHeight);
  if (height <= 0) {
    return 0;
  }
  const seen = (win.scrollY || root.scrollTop || 0) + win.innerHeight;
  const ratio = seen / height;
  if (ratio >= 0.99) return 100;
  if (ratio >= 0.75) return 75;
  if (ratio >= 0.5) return 50;
  if (ratio >= 0.25) return 25;
  return 0;
}

export function createEngagement(
  win: Window,
  doc: Document,
  onHeartbeat: () => void,
): Engagement {
  let visibleMs = 0;
  let since = doc.visibilityState === 'visible' ? Date.now() : 0;
  let deepest = 0;

  function bank(): void {
    if (since !== 0) {
      visibleMs += Date.now() - since;
      since = 0;
    }
  }

  function mark(): void {
    const quartile = scrollQuartile(win, doc);
    if (quartile > deepest) {
      deepest = quartile;
    }
  }

  return {
    start(): void {
      win.setInterval(() => {
        if (doc.visibilityState === 'visible') {
          onHeartbeat();
        }
      }, HEARTBEAT_MS);

      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') {
          since = Date.now();
          // One beat straight away, so a returning tab is online again without
          // waiting out the interval.
          onHeartbeat();
        } else {
          bank();
        }
      });

      win.addEventListener('scroll', mark, { passive: true });
      mark();
    },
    reset(): void {
      visibleMs = 0;
      since = doc.visibilityState === 'visible' ? Date.now() : 0;
      deepest = 0;
      mark();
    },
    duration(): number {
      return visibleMs + (since === 0 ? 0 : Date.now() - since);
    },
    scrollDepth(): number {
      return deepest;
    },
  };
}
