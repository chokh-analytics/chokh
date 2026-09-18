// A fixed window counter. One implementation carries the rate limits and the
// bot rate heuristic, and the map is thrown away whenever the window rolls, so
// memory stays bounded without a sweeper.
export interface WindowCounter {
  hit(key: string, now: number, by?: number): number;
}

export function createWindowCounter(windowMs: number): WindowCounter {
  let windowStart = 0;
  let counts = new Map<string, number>();

  return {
    hit(key: string, now: number, by = 1): number {
      if (now - windowStart >= windowMs) {
        windowStart = now;
        counts = new Map();
      }
      const next = (counts.get(key) ?? 0) + by;
      counts.set(key, next);
      return next;
    },
  };
}
