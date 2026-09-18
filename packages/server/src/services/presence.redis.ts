import { PRESENCE_WINDOW_MS, type Presence, type PresenceEntry } from '@chokh/store';
import { Redis } from 'ioredis';

// Who is here now, in Redis, so every process of an install sees the same
// visitors. Without it the map in @chokh/store answers the same questions for
// one process, which is a complete product on one container and not an install
// behind a load balancer.
//
// Two keys per site. A sorted set scored by the last sign of life answers "who
// has been seen since", which is the only question presence is ever asked; a
// hash beside it holds what each of them looks like, because a sorted set
// member has to stay the same string to be updated in place and the visitor's
// page changes on every heartbeat.

export const PRESENCE_PREFIX = 'chokh:live:';

export function liveKey(siteId: string): string {
  return `${PRESENCE_PREFIX}${siteId}`;
}

export function entryKey(siteId: string): string {
  return `${PRESENCE_PREFIX}${siteId}:e`;
}

// Both keys outlive the window by a margin, so a site that goes quiet takes
// itself out of Redis without anybody sweeping.
const KEY_TTL_SECONDS = Math.ceil((PRESENCE_WINDOW_MS * 2) / 1000);

// How many visitors past the window one write clears out. Pruning is cheap and
// constant this way, and a site busy enough to fall behind is a site whose
// next write catches up.
const PRUNE_AT_MOST = 200;

// The set and the hash have to move together, and a sighting must never be
// dragged backwards by a batch that arrived late, so the whole write is one
// script rather than a pipeline that could interleave with another process.
const TOUCH = `
local live, detail = KEYS[1], KEYS[2]
local ttl = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local prune = tonumber(ARGV[3])
local newest = 0
for i = 4, #ARGV, 3 do
  local id = ARGV[i]
  local seen = tonumber(ARGV[i + 1])
  local blob = ARGV[i + 2]
  local current = redis.call('ZSCORE', live, id)
  if (not current) or tonumber(current) <= seen then
    redis.call('ZADD', live, seen, id)
    redis.call('HSET', detail, id, blob)
  end
  if seen > newest then newest = seen end
end
local stale = redis.call('ZRANGEBYSCORE', live, '-inf', '(' .. (newest - window), 'LIMIT', 0, prune)
for i = 1, #stale do
  redis.call('ZREM', live, stale[i])
  redis.call('HDEL', detail, stale[i])
end
redis.call('EXPIRE', live, ttl)
redis.call('EXPIRE', detail, ttl)
return 1
`;

export interface RedisPresenceOptions {
  // Injected by the tests; a deployment passes a URL instead.
  client?: Redis;
  url?: string;
}

function parseEntry(raw: string | null): PresenceEntry | null {
  if (raw === null) {
    return null;
  }
  try {
    // Written by this process a moment ago, but a shared Redis is still input:
    // a row that will not parse is one visitor missing, not a crash.
    return JSON.parse(raw) as PresenceEntry;
  } catch {
    return null;
  }
}

export function createRedisPresence(options: RedisPresenceOptions): Presence {
  const client = options.client ?? new Redis(requiredUrl(options.url));
  const own = options.client === undefined;

  return {
    async touch(siteId: string, entries: PresenceEntry[]): Promise<void> {
      if (entries.length === 0) {
        return;
      }
      const args: string[] = [String(KEY_TTL_SECONDS), String(PRESENCE_WINDOW_MS), String(PRUNE_AT_MOST)];
      for (const entry of entries) {
        args.push(entry.visitorId, String(entry.lastSeenAt), JSON.stringify(entry));
      }
      await client.eval(TOUCH, 2, liveKey(siteId), entryKey(siteId), ...args);
    },

    async entries(siteId: string, since: number): Promise<PresenceEntry[]> {
      const live = liveKey(siteId);
      const detail = entryKey(siteId);
      const ids = await client.zrangebyscore(live, since, '+inf');
      if (ids.length === 0) {
        // Nothing live, so whatever the hash still holds is nobody. Letting it
        // go keeps a site that stopped from carrying its last visitors until
        // the key expires.
        return [];
      }
      const raw = await client.hmget(detail, ...ids);
      const found: PresenceEntry[] = [];
      for (const [index, value] of raw.entries()) {
        const entry = parseEntry(value);
        if (entry === null) {
          continue;
        }
        // The set is the truth about when, the hash about what. A sighting
        // that only reached the set still counts.
        const id = ids[index];
        found.push(id === undefined ? entry : { ...entry, visitorId: id });
      }
      return found;
    },

    async close(): Promise<void> {
      if (own) {
        await client.quit();
      }
    },
  };
}

function requiredUrl(url: string | undefined): string {
  if (url === undefined || url === '') {
    throw new Error('createRedisPresence needs a url or a client');
  }
  return url;
}
