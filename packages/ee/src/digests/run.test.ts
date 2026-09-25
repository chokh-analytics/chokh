import { createMemoryStore } from '@chokh/server/store/memory';
import { defaultSiteSettings, digestIdFor, type Digest, type StoredEvent } from '@chokh/store';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Deliverer, Mail } from '../alerts/deliver.js';
import type { LicenseState } from '../license/state.js';
import { runDigestsOnce, sendDigest, type DigestDeps } from './run.js';
import { periodFor } from './period.js';

// The digest tick (AN-RPT01): due once the hour has come in the site's
// zone, claimed once per period across ticks, one mail per address, what
// happened written on the row, and nothing at all on an install with no key.

const SITE_ID = 's_run';
const DHAKA = 'Asia/Dhaka';
const MORNING = Date.UTC(2026, 8, 25, 2, 5); // 08:05 in Dhaka
const EARLY = Date.UTC(2026, 8, 24, 21, 30); // 03:30 in Dhaka
const YESTERDAY = Date.UTC(2026, 8, 23, 18);

const licensed: LicenseState = {
  allows: () => ({ ok: true }),
  status: () => ({ state: 'licensed' }),
} as unknown as LicenseState;
const unlicensed: LicenseState = {
  allows: () => ({ ok: false, reason: 'missing' }),
  status: () => ({ state: 'none' }),
} as unknown as LicenseState;

function pageview(visitorId: string, ts: number): StoredEvent {
  return {
    siteId: SITE_ID,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId,
    path: '/',
    hostname: 'run.example',
    bot: false,
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country: 'BD', city: 'Dhaka' },
    lang: 'en',
  };
}

interface Sent {
  to: string;
  mail: Mail;
}

function fakeDeliverer(refuse: string[] = []): Deliverer & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    available: ['email'],
    sent,
    send: () => Promise.reject(new Error('not a channel test')),
    sendMail(to, mail) {
      sent.push({ to, mail });
      return Promise.resolve(refuse.includes(to) ? 'Mailbox unavailable' : null);
    },
  };
}

function digest(over: Partial<Digest> = {}): Digest {
  return {
    siteId: SITE_ID,
    id: digestIdFor(SITE_ID, 'daily'),
    cadence: 'daily',
    to: ['ops@example.test', 'boss@example.test'],
    hour: 8,
    createdBy: 'u_1',
    createdAt: EARLY - 86_400_000,
    ...over,
  };
}

describe('runDigestsOnce', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let clock = MORNING;
  let deliver: ReturnType<typeof fakeDeliverer>;
  const log = { info: () => {}, warn: () => {} };

  function deps(license: LicenseState = licensed): DigestDeps {
    return { store, deliver, license, log, publicUrl: 'https://analytics.example.test', now: () => clock };
  }

  beforeEach(async () => {
    clock = MORNING;
    store = createMemoryStore([], { now: () => clock });
    deliver = fakeDeliverer();
    await store.createSite({
      id: SITE_ID,
      name: 'Run site',
      domains: ['run.example'],
      settings: defaultSiteSettings({ timezone: DHAKA }),
    });
    await store.ingest([pageview('v_1', YESTERDAY + 3_600_000), pageview('v_2', YESTERDAY + 7_200_000)]);
    await store.rollupDay(SITE_ID, '2026-09-24');
    await store.createDigest(digest());
  });

  it('sends nothing on an install with no key, and says so once', async () => {
    const summary = await runDigestsOnce(deps(unlicensed));
    expect(summary).toEqual({ licensed: false, sites: 0, digests: 0, sent: 0, failed: 0 });
    expect(deliver.sent).toEqual([]);
  });

  it('waits for the hour, then sends once per period, one mail per address, and writes it down', async () => {
    clock = EARLY;
    expect((await runDigestsOnce(deps())).sent).toBe(0);
    expect(deliver.sent).toEqual([]);

    clock = MORNING;
    const summary = await runDigestsOnce(deps());
    expect(summary).toMatchObject({ licensed: true, sites: 1, digests: 1, sent: 2, failed: 0 });
    expect(deliver.sent.map((each) => each.to)).toEqual(['ops@example.test', 'boss@example.test']);
    expect(deliver.sent[0]?.mail.subject).toBe('Chokh: Run site on 2026-09-24');
    expect(deliver.sent[0]?.mail.text).toContain('Visitors     2');
    expect(deliver.sent[0]?.mail.attachments?.[0]?.name).toBe('s_run-daily-2026-09-24.pdf');

    // The same period again, later the same day: claimed already.
    clock = MORNING + 3_600_000;
    expect((await runDigestsOnce(deps())).sent).toBe(0);
    expect(deliver.sent).toHaveLength(2);

    const row = await store.digest(SITE_ID, digestIdFor(SITE_ID, 'daily'));
    expect(row?.lastPeriod).toBe('d:2026-09-24');
    expect(row?.last).toEqual({
      at: MORNING,
      period: 'd:2026-09-24',
      deliveries: [
        { channel: 'email', target: 'ops@example.test', ok: true },
        { channel: 'email', target: 'boss@example.test', ok: true },
      ],
    });

    // Tomorrow at the hour: the next period.
    clock = MORNING + 86_400_000;
    expect((await runDigestsOnce(deps())).sent).toBe(2);
    expect((await store.digest(SITE_ID, digestIdFor(SITE_ID, 'daily')))?.lastPeriod).toBe('d:2026-09-25');
  });

  it('keeps a period claimed when a mail reached nobody, and says which address', async () => {
    deliver = fakeDeliverer(['boss@example.test']);
    const summary = await runDigestsOnce(deps());
    expect(summary).toMatchObject({ sent: 1, failed: 1 });
    const row = await store.digest(SITE_ID, digestIdFor(SITE_ID, 'daily'));
    expect(row?.last?.deliveries[1]).toEqual({
      channel: 'email',
      target: 'boss@example.test',
      ok: false,
      error: 'Mailbox unavailable',
    });
    expect((await runDigestsOnce(deps())).sent).toBe(0);
  });

  it('sends a weekly digest on its day only', async () => {
    await store.createDigest(digest({ id: digestIdFor(SITE_ID, 'weekly'), cadence: 'weekly', weekday: 1 }));
    // Friday the 25th: the daily goes, the weekly waits.
    expect((await runDigestsOnce(deps())).sent).toBe(2);
    // Monday the 28th: the weekly goes, for the week to the 27th.
    clock = Date.UTC(2026, 8, 28, 2, 5);
    const monday = await runDigestsOnce(deps());
    expect(monday.sent).toBe(4);
    const weekly = deliver.sent.filter((each) => each.mail.subject.includes('the week'));
    expect(weekly).toHaveLength(2);
    expect(weekly[0]?.mail.subject).toBe('Chokh: Run site, the week to 2026-09-27');
  });
});

describe('sendDigest', () => {
  it('sends the period asked for now, whatever the hour, and records it', async () => {
    const store = createMemoryStore([], { now: () => EARLY });
    const site = {
      id: SITE_ID,
      name: 'Run site',
      domains: ['run.example'],
      settings: defaultSiteSettings({ timezone: DHAKA }),
    };
    await store.createSite(site);
    await store.createDigest(digest());
    const deliver = fakeDeliverer();
    const deliveries = await sendDigest(
      { store, deliver, publicUrl: undefined, now: () => EARLY },
      site,
      digest(),
      periodFor('daily', EARLY, DHAKA),
    );
    expect(deliveries.map((each) => each.ok)).toEqual([true, true]);
    expect(deliver.sent[0]?.mail.text).not.toContain('Open the dashboard');
    expect((await store.digest(SITE_ID, digestIdFor(SITE_ID, 'daily')))?.last?.period).toBe('d:2026-09-24');
  });
});
