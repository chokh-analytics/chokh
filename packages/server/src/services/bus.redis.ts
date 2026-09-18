import { Redis } from 'ioredis';

import type { Bus, BusListener } from './bus.js';

// The same bus over Redis pub/sub, so a stream on one container wakes on a batch
// accepted by another.
//
// Two connections, because a Redis client in subscriber mode cannot run ordinary
// commands: one publishes, one subscribes. The message body is the site id and
// nothing else; the stream reads the presence snapshot for itself afterwards.
// A nudge that is lost costs at most one second of latency, because the stream
// also refreshes on a timer, which is why none of this needs to be reliable.

export const REALTIME_CHANNEL_PREFIX = 'chokh:realtime:';

export function realtimeChannel(siteId: string): string {
  return `${REALTIME_CHANNEL_PREFIX}${siteId}`;
}

export interface RedisBusOptions {
  url: string;
}

export function createRedisBus(options: RedisBusOptions): Bus {
  const publisher = new Redis(options.url, { lazyConnect: true, maxRetriesPerRequest: null });
  const subscriber = publisher.duplicate();
  const bySite = new Map<string, Set<BusListener>>();

  subscriber.on('message', (channel: string) => {
    const siteId = channel.slice(REALTIME_CHANNEL_PREFIX.length);
    for (const listener of bySite.get(siteId) ?? []) {
      listener();
    }
  });

  // Losing Redis is not losing the product: the streams keep refreshing on their
  // own timer and ioredis reconnects underneath. Unhandled error events would
  // take the process down for something that costs a second of latency.
  publisher.on('error', () => undefined);
  subscriber.on('error', () => undefined);

  return {
    async publish(siteId: string): Promise<void> {
      await publisher.publish(realtimeChannel(siteId), siteId);
    },

    async subscribe(siteId: string, listener: BusListener): Promise<() => Promise<void>> {
      const listeners = bySite.get(siteId);
      if (listeners === undefined) {
        bySite.set(siteId, new Set([listener]));
        await subscriber.subscribe(realtimeChannel(siteId));
      } else {
        listeners.add(listener);
      }
      return async () => {
        const current = bySite.get(siteId);
        if (current === undefined) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          bySite.delete(siteId);
          // The last watcher of this site left, so stop carrying its traffic.
          await subscriber.unsubscribe(realtimeChannel(siteId));
        }
      };
    },

    async close(): Promise<void> {
      bySite.clear();
      await Promise.all([publisher.quit(), subscriber.quit()]);
    },
  };
}
