import { useEffect, useRef, useState } from 'react';

// The live stream, and what happens when it is not there.
//
// A frame's data is the same success envelope a poll returns, which is why the
// server framed it that way: one parse for both. The connection state is on
// screen rather than hidden, because somebody reading a page that says "live"
// deserves to know whether it is.
//
// Four states and not three, because the interesting one is the middle.
// EventSource reconnects on its own, about every three seconds, and a stream
// that is retrying carries nothing: with no reconnecting state the page said
// Live for nine seconds with no frame in it while the poll behind it was
// switched off. A drop every forty five seconds never reached three inside the
// window either, so a connection that failed all afternoon never fell back.

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'polling';

// How many failures before giving up on the stream for this visit. EventSource
// reconnects on its own, so this counts its attempts rather than making any:
// three inside the window below is a proxy that will not carry the stream, not
// a blip.
const GIVE_UP_AFTER = 3;
const GIVE_UP_WINDOW_MS = 30_000;

export interface StreamResult<T> {
  data: T | null;
  state: StreamState;
}

export interface StreamOptions {
  // Injected so a test can drive one without a network, and so a browser
  // without EventSource falls straight through to polling.
  create?: (url: string) => EventSource;
}

export function useEventStream<T>(url: string, options: StreamOptions = {}): StreamResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<StreamState>('connecting');
  const failures = useRef<number[]>([]);
  // A decision that lasts the visit. Without it, coming back to the tab
  // restarted a stream that had already been given up on, and the pill went
  // back to claiming a connection nobody had.
  const gaveUp = useRef(false);

  useEffect(() => {
    const make = options.create ?? ((at: string) => new EventSource(at));
    if (typeof EventSource !== 'function' && options.create === undefined) {
      setState('polling');
      return;
    }

    let source: EventSource | null = null;
    let open = true;

    const start = (): void => {
      if (!open || gaveUp.current) {
        return;
      }
      // Same origin, so the session cookie goes on its own. EventSource could
      // not set a header even if one were wanted.
      source = make(url);
      source.onopen = () => setState('live');
      source.onmessage = (event: MessageEvent<string>) => {
        try {
          const envelope: unknown = JSON.parse(event.data);
          if (
            typeof envelope === 'object' &&
            envelope !== null &&
            (envelope as { success?: boolean }).success === true
          ) {
            setData((envelope as { data: T }).data);
            setState('live');
            // A frame arrived, so whatever went wrong before it is history:
            // the window counts the failures of one bad spell, not of one
            // afternoon.
            failures.current = [];
          }
        } catch {
          // A frame that is not JSON is a frame. The next one is a second away.
        }
      };
      source.onerror = () => {
        const now = Date.now();
        failures.current = [...failures.current, now].filter(
          (at) => at > now - GIVE_UP_WINDOW_MS,
        );
        if (failures.current.length >= GIVE_UP_AFTER) {
          gaveUp.current = true;
          source?.close();
          source = null;
          setState('polling');
          return;
        }
        // Retrying, which is not connected. The page polls in the meantime
        // rather than standing still behind a pill that says Live.
        setState('reconnecting');
      };
    };

    const onVisible = (): void => {
      // A stream held open behind a hidden tab is a socket and a frame every
      // ten seconds for a page nobody is looking at.
      if (document.hidden) {
        source?.close();
        source = null;
      } else if (source === null && open && !gaveUp.current) {
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      open = false;
      document.removeEventListener('visibilitychange', onVisible);
      source?.close();
    };
  }, [url, options.create]);

  return { data, state };
}
