import {
  ONLINE_WINDOW_MS,
  REALTIME_WINDOW_MS,
  type CountRow,
  type RealtimeSnapshot,
  type RealtimeVisitor,
} from './query.js';
import type { StoredSession } from './types.js';

// Who is here now. This is deliberately not storage: it is a sixty second
// window over a thirty minute set, it is rebuilt from the next heartbeat if it
// is ever lost, and asking a database "which of a hundred million rows arrived
// in the last minute" is the wrong question to keep asking. Ingest writes one
// entry per live visitor and realtime() reads it back; the raw events are never
// scanned for this.
//
// The set lives in Redis when a deployment has one, so every process in an
// install sees the same visitors, and in a map when it does not, so one image
// with nothing beside it is still a complete product. The map is here rather
// than in the server because every adapter needs a default and no adapter may
// depend on the server.

// How long an entry is kept. Longer than online, because the live feed and the
// last half hour sparkline read the same set.
export const PRESENCE_WINDOW_MS = REALTIME_WINDOW_MS;

export interface PresenceEntry {
  visitorId: string;
  sessionId: string;
  // The start of the stay, which is what "online for 12 minutes" counts from.
  since: number;
  lastSeenAt: number;
  path?: string;
  country?: string;
  city?: string;
  browser?: string;
  os?: string;
  device?: string;
  ip?: string;
  userId?: string;
}

export interface Presence {
  // One entry per visitor. A later touch replaces an earlier one.
  touch(siteId: string, entries: PresenceEntry[]): Promise<void>;
  // Everyone whose last sign of life is at or after the instant given.
  entries(siteId: string, since: number): Promise<PresenceEntry[]>;
  close(): Promise<void>;
}

// A live visitor as their session describes them. A crawler is not a visitor,
// so it is never put in the set and never counted as online.
export function presenceEntryOf(session: StoredSession): PresenceEntry | null {
  if (session.bot) {
    return null;
  }
  const entry: PresenceEntry = {
    visitorId: session.visitorId,
    sessionId: session.id,
    since: session.startedAt,
    lastSeenAt: session.lastSeenAt,
  };
  // The page they are on now is where the stay has got to, not where it began.
  if (session.exitPath !== undefined) entry.path = session.exitPath;
  if (session.geo?.country !== undefined) entry.country = session.geo.country;
  if (session.geo?.city !== undefined) entry.city = session.geo.city;
  if (session.ua?.browser !== undefined) entry.browser = session.ua.browser;
  if (session.ua?.os !== undefined) entry.os = session.ua.os;
  if (session.ua?.device !== undefined) entry.device = session.ua.device;
  if (session.ip !== undefined) entry.ip = session.ip;
  if (session.userId !== undefined) entry.userId = session.userId;
  return entry;
}

function toVisitor(entry: PresenceEntry): RealtimeVisitor {
  const visitor: RealtimeVisitor = {
    visitorId: entry.visitorId,
    since: entry.since,
    lastSeenAt: entry.lastSeenAt,
  };
  if (entry.userId !== undefined) visitor.userId = entry.userId;
  if (entry.path !== undefined) visitor.path = entry.path;
  if (entry.country !== undefined) visitor.country = entry.country;
  if (entry.city !== undefined) visitor.city = entry.city;
  if (entry.browser !== undefined) visitor.browser = entry.browser;
  if (entry.os !== undefined) visitor.os = entry.os;
  if (entry.device !== undefined) visitor.device = entry.device;
  if (entry.ip !== undefined) visitor.ip = entry.ip;
  return visitor;
}

function tally(
  visitors: RealtimeVisitor[],
  pick: (visitor: RealtimeVisitor) => string | undefined,
): CountRow[] {
  const counts = new Map<string, number>();
  for (const visitor of visitors) {
    const key = pick(visitor);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, total]) => ({ key, visitors: total }))
    .sort((left, right) => right.visitors - left.visitors || left.key.localeCompare(right.key));
}

// The snapshot both adapters answer with, built from the set rather than from
// rows, so the MongoDB answer and the in-memory answer are the same sentence.
export function snapshotFrom(entries: PresenceEntry[], now: number): RealtimeSnapshot {
  const visitors = entries
    .filter((entry) => entry.lastSeenAt > now - ONLINE_WINDOW_MS && entry.lastSeenAt <= now)
    .map(toVisitor)
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  const signedIn = visitors.filter((visitor) => visitor.userId !== undefined).length;
  return {
    online: visitors.length,
    signedIn,
    anonymous: visitors.length - signedIn,
    byPage: tally(visitors, (visitor) => visitor.path),
    byCountry: tally(visitors, (visitor) => visitor.country),
    visitors,
  };
}

export interface MemoryPresence extends Presence {
  // Test seam, the way MemoryStore.clear is one: never called in production.
  clear(): void;
}

// How many live visitors one process holds before a write prunes the stale
// ones. Only a read prunes otherwise, and a busy site nobody is watching would
// keep every visitor of the day.
const MEMORY_PRESENCE_PRUNE_AT = 10_000;

export function createMemoryPresence(): MemoryPresence {
  const bySite = new Map<string, Map<string, PresenceEntry>>();

  function live(siteId: string): Map<string, PresenceEntry> {
    const existing = bySite.get(siteId);
    if (existing !== undefined) {
      return existing;
    }
    const made = new Map<string, PresenceEntry>();
    bySite.set(siteId, made);
    return made;
  }

  return {
    touch(siteId: string, entries: PresenceEntry[]): Promise<void> {
      const set = live(siteId);
      let newest = 0;
      for (const entry of entries) {
        const known = set.get(entry.visitorId);
        // A batch can arrive after a newer one; the freshest sighting wins.
        if (known === undefined || known.lastSeenAt <= entry.lastSeenAt) {
          set.set(entry.visitorId, { ...entry });
        }
        newest = Math.max(newest, entry.lastSeenAt);
      }
      // A busy site nobody is watching would otherwise hold every visitor of
      // the day in memory, because only a read prunes.
      if (set.size > MEMORY_PRESENCE_PRUNE_AT) {
        for (const [visitorId, entry] of set) {
          if (entry.lastSeenAt < newest - PRESENCE_WINDOW_MS) {
            set.delete(visitorId);
          }
        }
      }
      return Promise.resolve();
    },

    entries(siteId: string, since: number): Promise<PresenceEntry[]> {
      const set = bySite.get(siteId);
      if (set === undefined) {
        return Promise.resolve([]);
      }
      const found: PresenceEntry[] = [];
      for (const [visitorId, entry] of set) {
        // Anything past the window is gone for good, so the map is pruned on
        // the way past rather than by a timer nobody would ever clear.
        if (entry.lastSeenAt < since - PRESENCE_WINDOW_MS) {
          set.delete(visitorId);
          continue;
        }
        if (entry.lastSeenAt >= since) {
          found.push({ ...entry });
        }
      }
      return Promise.resolve(found);
    },

    clear(): void {
      bySite.clear();
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
