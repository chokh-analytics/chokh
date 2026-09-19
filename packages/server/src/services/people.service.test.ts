import { describe, expect, it } from 'vitest';

import {
  ONLINE_WINDOW_MS,
  REALTIME_WINDOW_MS,
  defaultSiteSettings,
  type Presence,
  type PresenceEntry,
  type Site,
} from '../store/AnalyticsStore.js';
import { createMemoryStore } from '../store/memory.store.js';
import { userPresence } from './people.service.js';

// The online badge beside one person's name.
//
// What is under test is the range it reads. The presence set holds half an
// hour and this is a question about the last minute, so asking for the half
// hour is thirty times the sorted-set range for the same yes or no. The store
// defaults to the whole window because Realtime draws the whole window, which
// is why one caller passing the minute has to be asserted here.

const SITE = 'site_people';
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const SITE_ROW: Site = {
  id: SITE,
  name: 'People',
  domains: ['people.test'],
  settings: defaultSiteSettings(),
};

// A presence port that says what it was asked for. The instant is the only
// thing that distinguishes the two reads, because a snapshot counts the online
// minute either way: the cost is in the range, not in the answer.
function recordingPresence(entries: PresenceEntry[]): Presence & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    touch: () => Promise.resolve(),
    entries: (_siteId: string, since: number) => {
      asked.push(since);
      return Promise.resolve(entries.filter((entry) => entry.lastSeenAt >= since));
    },
    close: () => Promise.resolve(),
  };
}

describe('userPresence', () => {
  it('reads the online minute rather than the whole presence window', async () => {
    const presence = recordingPresence([]);
    const store = createMemoryStore([SITE_ROW], { presence, now: () => NOW });

    await userPresence(store, SITE, 'u_1');

    expect(presence.asked).toHaveLength(1);
    expect(NOW - (presence.asked[0] ?? 0)).toBe(ONLINE_WINDOW_MS);
    expect(NOW - (presence.asked[0] ?? 0)).not.toBe(REALTIME_WINDOW_MS);
  });

  it('says online, where and since when for somebody inside the minute', async () => {
    const presence = recordingPresence([
      {
        visitorId: 'v_now',
        sessionId: 's_now',
        userId: 'u_2',
        since: NOW - 300_000,
        lastSeenAt: NOW - 20_000,
        path: '/docs',
      },
    ]);
    const store = createMemoryStore([SITE_ROW], { presence, now: () => NOW });

    const outcome = await userPresence(store, SITE, 'u_2');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual({
      online: true,
      page: '/docs',
      since: NOW - 300_000,
      lastSeenAt: NOW - 20_000,
    });
  });
});
