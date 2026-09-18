import { env } from '../config/env.js';
import { createMemoryBus, type Bus } from '../services/bus.js';
import { createRedisBus } from '../services/bus.redis.js';
import { createMemoryOnce, createRedisOnce, type OnceOnly } from '../services/once.js';

// The two things that are Redis when there is a Redis and this process when there
// is not, the same way presence is: the nudge that wakes a realtime stream, and
// the set that stops an SSO token being exchanged twice.
//
// Neither is storage. Losing the bus costs a second of latency, because a stream
// refreshes on a timer anyway. Losing the replay set costs one replay window. A
// deployment running more than one container should have Redis, and the server
// README says why in the same words.

export function openBus(): { bus: Bus; kind: string } {
  if (env.REDIS_URL === undefined) {
    return { bus: createMemoryBus(), kind: 'memory' };
  }
  return { bus: createRedisBus({ url: env.REDIS_URL }), kind: 'redis' };
}

export function openOnce(now: () => number): { once: OnceOnly; kind: string } {
  if (env.REDIS_URL === undefined) {
    return { once: createMemoryOnce(now), kind: 'memory' };
  }
  return { once: createRedisOnce(env.REDIS_URL), kind: 'redis' };
}
