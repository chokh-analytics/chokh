import { useEffect, useRef, useState } from 'react';

// The live stream, and what happens when it is not there.
//
// A frame's data is the same success envelope a poll returns, which is why the
// server framed it that way: one parse for both. The connection state is on
// screen rather than hidden, because somebody reading a page that says "live"
// deserves to know whether it is.

export type StreamState = 'connecting' | 'live' | 'polling';

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

  useEffect(() => {
    const make = options.create ?? ((at: string) => new EventSource(at));
    if (typeof EventSource !== 'function' && options.create === undefined) {
      setState('polling');
      return;
    }

    let source: EventSource | null = null;
    let open = true;

    const start = (): void => {
      if (!open) {
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
          source?.close();
          source = null;
          setState('polling');
        }
      };
    };

    const onVisible = (): void => {
      // A stream held open behind a hidden tab is a socket and a frame every
      // ten seconds for a page nobody is looking at.
      if (document.hidden) {
        source?.close();
        source = null;
      } else if (source === null && open) {
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
