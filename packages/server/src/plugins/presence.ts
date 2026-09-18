import { createMemoryPresence, type Presence } from '@chokh/store';

import { env } from '../config/env.js';
import { createRedisPresence } from '../services/presence.redis.js';

// Where this deployment keeps who is here now. Redis when it has one, so every
// process of an install counts the same visitors and a dashboard behind a load
// balancer does not report a different number on every refresh; a map in this
// process when it does not, so one image with nothing beside it is still a
// complete install.
//
// Presence is never storage: it is a sixty second window over a half hour set,
// rebuilt by the next heartbeat if it is ever lost. Which is why losing Redis
// costs a minute of "online now" and nothing else.
export function openPresence(): { presence: Presence; kind: string } {
  if (env.REDIS_URL === undefined) {
    return { presence: createMemoryPresence(), kind: 'memory' };
  }
  return { presence: createRedisPresence({ url: env.REDIS_URL }), kind: 'redis' };
}
