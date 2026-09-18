import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { PRESENCE_WINDOW_MS, type Presence, type PresenceEntry } from '../presence.js';

// The one suite every presence backend passes, for the same reason the store
// has one: a Redis install and a Redis-less install must answer "who is here"
// with the same sentence, or the dashboard changes meaning when an operator
// adds Redis.

export interface PresenceHarness {
  presence: Presence;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const SITE = 'site_presence';
const OTHER = 'site_other';
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);

function entry(over: Partial<PresenceEntry> & { visitorId: string }): PresenceEntry {
  return {
    sessionId: `s_${over.visitorId}`,
    since: NOW - 600_000,
    lastSeenAt: NOW - 10_000,
    ...over,
  };
}

export function runPresenceConformance(name: string, create: () => Promise<PresenceHarness>): void {
  describe(`Presence conformance: ${name}`, () => {
    let harness: PresenceHarness;
    let presence: Presence;

    beforeEach(async () => {
      harness ??= await create();
      presence = harness.presence;
      await harness.reset();
    });

    afterAll(async () => {
      await harness.close();
    });

    it('answers with nothing for a site nobody has visited', async () => {
      expect(await presence.entries(SITE, NOW - 60_000)).toEqual([]);
    });

    it('gives back what it was told, whole', async () => {
      const one = entry({
        visitorId: 'v1',
        path: '/pricing',
        country: 'BD',
        city: 'Dhaka',
        browser: 'Chrome',
        os: 'Android',
        device: 'mobile',
        ip: '103.87.12.9',
        userId: 'u_rafi',
      });
      await presence.touch(SITE, [one]);
      expect(await presence.entries(SITE, NOW - 60_000)).toEqual([one]);
    });

    it('keeps one entry per visitor, the freshest', async () => {
      await presence.touch(SITE, [entry({ visitorId: 'v1', path: '/a', lastSeenAt: NOW - 40_000 })]);
      await presence.touch(SITE, [entry({ visitorId: 'v1', path: '/b', lastSeenAt: NOW - 10_000 })]);
      const found = await presence.entries(SITE, NOW - 60_000);
      expect(found).toHaveLength(1);
      expect(found[0]?.path).toBe('/b');
    });

    it('does not let a late batch undo a newer sighting', async () => {
      await presence.touch(SITE, [entry({ visitorId: 'v1', path: '/b', lastSeenAt: NOW - 10_000 })]);
      await presence.touch(SITE, [entry({ visitorId: 'v1', path: '/a', lastSeenAt: NOW - 40_000 })]);
      const found = await presence.entries(SITE, NOW - 60_000);
      expect(found[0]?.path).toBe('/b');
      expect(found[0]?.lastSeenAt).toBe(NOW - 10_000);
    });

    it('leaves out anyone last seen before the instant asked for', async () => {
      await presence.touch(SITE, [
        entry({ visitorId: 'here', lastSeenAt: NOW - 30_000 }),
        entry({ visitorId: 'gone', lastSeenAt: NOW - 90_000 }),
      ]);
      const found = await presence.entries(SITE, NOW - 60_000);
      expect(found.map((one) => one.visitorId)).toEqual(['here']);
    });

    it('holds the whole window, not only the online minute', async () => {
      await presence.touch(SITE, [entry({ visitorId: 'earlier', lastSeenAt: NOW - 20 * 60_000 })]);
      const found = await presence.entries(SITE, NOW - PRESENCE_WINDOW_MS);
      expect(found.map((one) => one.visitorId)).toEqual(['earlier']);
    });

    it('keeps one site out of another', async () => {
      await presence.touch(SITE, [entry({ visitorId: 'mine' })]);
      await presence.touch(OTHER, [entry({ visitorId: 'theirs' })]);
      expect((await presence.entries(SITE, NOW - 60_000)).map((one) => one.visitorId)).toEqual([
        'mine',
      ]);
      expect((await presence.entries(OTHER, NOW - 60_000)).map((one) => one.visitorId)).toEqual([
        'theirs',
      ]);
    });

    it('takes a batch of visitors at once', async () => {
      await presence.touch(SITE, [
        entry({ visitorId: 'v1' }),
        entry({ visitorId: 'v2' }),
        entry({ visitorId: 'v3' }),
      ]);
      const found = await presence.entries(SITE, NOW - 60_000);
      expect(found.map((one) => one.visitorId).sort()).toEqual(['v1', 'v2', 'v3']);
    });
  });
}
