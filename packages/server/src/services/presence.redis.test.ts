import { runPresenceConformance } from '@chokh/store/conformance';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { createRedisPresence, entryKey, liveKey, PRESENCE_PREFIX } from './presence.redis.js';

// The Redis backend passes the same presence suite the map does, because an
// install that adds Redis must not change what "who is here" means.
//
// It runs against a real Redis rather than a stand-in: the whole point of this
// file is the sorted set, and a fake sorted set would only prove that the fake
// agrees with itself. CI gives the job a redis service and sets REDIS_URL; a
// laptop without one skips, which the line below says out loud.
const url = process.env.REDIS_URL;

if (url === undefined || url === '') {
  describe.skip('Presence conformance: redis', () => {
    it('needs REDIS_URL to point at a Redis, which CI provides', () => {
      expect(true).toBe(true);
    });
  });
} else {
  runPresenceConformance('redis', async () => {
    const client = new Redis(url, { lazyConnect: true });
    await client.connect();
    const presence = createRedisPresence({ client });
    const wipe = async (): Promise<void> => {
      const keys = await client.keys(`${PRESENCE_PREFIX}*`);
      if (keys.length > 0) {
        await client.del(...keys);
      }
    };
    await wipe();
    return {
      presence,
      reset: wipe,
      close: async () => {
        await wipe();
        await presence.close();
        await client.quit();
      },
    };
  });
}

describe('the keys presence writes', () => {
  it('namespaces one site away from another', () => {
    expect(liveKey('site_1')).toBe('chokh:live:site_1');
    expect(entryKey('site_1')).toBe('chokh:live:site_1:e');
    expect(liveKey('site_1')).not.toBe(liveKey('site_2'));
  });

  it('refuses to be built without somewhere to connect to', () => {
    expect(() => createRedisPresence({})).toThrow(/needs a url/);
  });
});
