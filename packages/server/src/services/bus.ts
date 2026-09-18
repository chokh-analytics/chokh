// The nudge that wakes a realtime stream.
//
// A dashboard watching a site holds an SSE connection; the collector, somewhere
// else in the process or on another container, accepts a batch. The bus is how
// the second tells the first that there is something new to look at, and it
// carries no data: the stream answers with the presence snapshot afterwards, so
// there is one source of truth for who is online and the nudge cannot disagree
// with it.
//
// Redis pub/sub when an install has Redis, because then every container's
// streams wake on every container's batches; an emitter in this process when it
// does not, which is a complete product on one image. The same choice presence
// makes, for the same reason.

export type BusListener = () => void;

export interface Bus {
  publish(siteId: string): Promise<void>;
  // Answers with the unsubscribe. Called when the stream closes, which is the
  // only thing standing between a long lived server and a listener leak.
  subscribe(siteId: string, listener: BusListener): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export function createMemoryBus(): Bus {
  const bySite = new Map<string, Set<BusListener>>();

  return {
    publish(siteId: string): Promise<void> {
      for (const listener of bySite.get(siteId) ?? []) {
        listener();
      }
      return Promise.resolve();
    },

    subscribe(siteId: string, listener: BusListener): Promise<() => Promise<void>> {
      const listeners = bySite.get(siteId) ?? new Set<BusListener>();
      bySite.set(siteId, listeners);
      listeners.add(listener);
      return Promise.resolve(() => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          bySite.delete(siteId);
        }
        return Promise.resolve();
      });
    },

    close(): Promise<void> {
      bySite.clear();
      return Promise.resolve();
    },
  };
}
