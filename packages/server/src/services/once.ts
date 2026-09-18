import { Redis } from 'ioredis';

// "Has this been used before?", with a window.
//
// The SSO exchange needs it. A five minute token that can be replayed is a five
// minute password: anybody who reads it out of a URL, a proxy log or a browser
// history can present it again and get a session. So each token carries a jti,
// the first exchange claims it, and every later one is refused until it expires
// on its own.
//
// Redis when an install has it, so two containers cannot each accept the same
// token once; a map in this process when it does not. The fallback is honest
// about what it is: on one container it is exact, and an install running several
// without Redis gets one replay per container, which is why the README says to
// give a multi-process install a Redis.

export interface OnceOnly {
  // True the first time this key is claimed, false every time after, until ttl.
  claim(key: string, ttlMs: number): Promise<boolean>;
  close(): Promise<void>;
}

// How many claims one process holds before a sweep. Claims are tiny and the
// window is minutes, so this is only here so a long running process cannot grow
// without bound.
const MEMORY_SWEEP_AT = 10_000;

export function createMemoryOnce(now: () => number): OnceOnly {
  const seen = new Map<string, number>();

  return {
    claim(key: string, ttlMs: number): Promise<boolean> {
      const at = now();
      const until = seen.get(key);
      if (until !== undefined && until > at) {
        return Promise.resolve(false);
      }
      if (seen.size > MEMORY_SWEEP_AT) {
        for (const [candidate, expiry] of seen) {
          if (expiry <= at) {
            seen.delete(candidate);
          }
        }
      }
      seen.set(key, at + ttlMs);
      return Promise.resolve(true);
    },

    close(): Promise<void> {
      seen.clear();
      return Promise.resolve();
    },
  };
}

export const ONCE_PREFIX = 'chokh:once:';

export function createRedisOnce(url: string): OnceOnly {
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
  redis.on('error', () => undefined);

  return {
    async claim(key: string, ttlMs: number): Promise<boolean> {
      // SET NX is the whole thing: one round trip, atomic across every process
      // of the install, and it forgets on its own when the window closes.
      const written = await redis.set(`${ONCE_PREFIX}${key}`, '1', 'PX', ttlMs, 'NX');
      return written === 'OK';
    },

    async close(): Promise<void> {
      await redis.quit();
    },
  };
}
