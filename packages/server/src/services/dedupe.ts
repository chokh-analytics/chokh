// A pageview repeated within two seconds is one pageview: a double fired
// router, a reload storm, a retried beacon.
export const DEDUPE_WINDOW_MS = 2000;

const MAX_KEYS = 50_000;

export interface Dedupe {
  seen(key: string, now: number): boolean;
}

export function createDedupe(windowMs: number = DEDUPE_WINDOW_MS): Dedupe {
  const lastSeen = new Map<string, number>();

  function prune(now: number): void {
    for (const [key, at] of lastSeen) {
      if (now - at >= windowMs) {
        lastSeen.delete(key);
      }
    }
  }

  return {
    seen(key: string, now: number): boolean {
      const at = lastSeen.get(key);
      if (at !== undefined && now - at < windowMs) {
        return true;
      }
      if (lastSeen.size >= MAX_KEYS) {
        prune(now);
      }
      lastSeen.set(key, now);
      return false;
    },
  };
}
