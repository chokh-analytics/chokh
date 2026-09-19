import { useEffect, useState } from 'react';

// A clock that ticks, rounded so it does not tick constantly.
//
// Every range in this dashboard is resolved against "now": Today runs to it,
// 7 days runs to it, and the query key is built from the window that comes out.
// Read once at render, the clock stops the moment the page settles, so a
// dashboard left open all afternoon keeps asking about the same [from, to] for
// ever. The KPIs freeze while Online now, which polls on its own, keeps moving:
// the worst shape of this bug, because the page looks alive.
//
// The value is rounded down to the tick, so the query key changes once per tick
// rather than on every render. At the default that is one new key a minute and
// one refetch of a live range, which is what the thirty second staleTime in
// queries.ts was already asking for.
export const NOW_TICK_MS = 60_000;

export function roundedNow(at: number, everyMs = NOW_TICK_MS): number {
  return Math.floor(at / everyMs) * everyMs;
}

export function useNow(everyMs = NOW_TICK_MS): number {
  const [now, setNow] = useState(() => roundedNow(Date.now(), everyMs));

  useEffect(() => {
    const tick = (): void => {
      // Never while the tab is hidden: a background tab that keeps advancing
      // its window is a background tab that keeps asking the server about it.
      if (!document.hidden) {
        setNow(roundedNow(Date.now(), everyMs));
      }
    };
    const timer = setInterval(tick, everyMs);
    // Coming back to the tab is the moment the clock is most wrong, and the
    // interval above may be up to a whole tick away.
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [everyMs]);

  return now;
}
