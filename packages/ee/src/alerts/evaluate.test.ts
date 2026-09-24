import type { Alert, AlertChannel, AlertCondition, AlertDelivery, StoredEvent } from '@chokh/store';
import { alertIdFor, defaultSiteSettings, goalIdFor } from '@chokh/store';
import { createMemoryStore } from '@chokh/server/store/memory';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LicenseState } from '../license/state.js';
import { DAY_MS, HOUR_MS, SKIPPED, TICK_MS } from './conditions.js';
import type { Deliverer } from './deliver.js';
import type { AlertMessage } from './messages.js';
import { measure, runAlertsOnce, type EvaluateDeps } from './evaluate.js';

// The tick over the real in-memory adapter, with the clock held and a
// deliverer that remembers. Every kind fires, holds and recovers here; the
// claim is proved to turn a second pass away; and a delivery that reaches
// nobody is proved to leave the state where it was.

const SITE = 's_alerts';
// 2026-09-24 10:17 UTC, a Thursday. The last completed hour is 09:00 to 10:00.
const NOW = Date.UTC(2026, 8, 24, 10, 17, 0);
const SIGNUP = goalIdFor(SITE, 'event', 'signup');

const licensed: LicenseState = {
  allows: () => ({ ok: true }),
  status: () => ({ licensed: true, plan: 'pro', licensee: 'Test', expiresAt: null, features: ['*'] }),
};
const unlicensed: LicenseState = {
  allows: () => ({ ok: false, reason: 'missing' }),
  status: () => ({ licensed: false, plan: null, licensee: null, expiresAt: null, features: [] }),
};

interface Sent {
  channel: AlertChannel;
  message: AlertMessage;
}

function fakeDeliverer(answer: (channel: AlertChannel) => AlertDelivery): Deliverer & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    available: ['email', 'telegram', 'webhook'],
    sent,
    send(channel, message) {
      sent.push({ channel, message });
      return Promise.resolve(answer(channel));
    },
  };
}

const delivered = (channel: AlertChannel): AlertDelivery => ({ channel: channel.kind, target: 'x', ok: true });
const refused = (channel: AlertChannel): AlertDelivery => ({ channel: channel.kind, target: 'x', ok: false, error: 'down' });

let visitorSeq = 0;
function pageview(ts: number, over: Partial<StoredEvent> = {}): StoredEvent {
  visitorSeq += 1;
  return {
    siteId: SITE,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId: `v_${visitorSeq}`,
    path: '/',
    bot: false,
    ...over,
  };
}

function alertOf(condition: AlertCondition, name = 'An alert', channels: AlertChannel[] = [{ kind: 'webhook', url: 'https://hooks.example.test/a' }]): Alert {
  return {
    siteId: SITE,
    id: alertIdFor(SITE, condition),
    name,
    condition,
    channels,
    createdBy: 'u_1',
    createdAt: NOW - DAY_MS,
    state: { firing: false },
    recent: [],
  };
}

const DROP: AlertCondition = { kind: 'traffic', metric: 'visitors', direction: 'down', percent: 50, minimum: 20 };

describe('the alert tick', () => {
  let clock: number;
  let store: ReturnType<typeof createMemoryStore>;
  let deliverer: ReturnType<typeof fakeDeliverer>;
  let log: { lines: string[] };
  let deps: EvaluateDeps;

  beforeEach(async () => {
    clock = NOW;
    visitorSeq = 0;
    store = createMemoryStore([], { now: () => clock });
    await store.createSite({
      id: SITE,
      name: 'Example',
      domains: ['example.test'],
      settings: defaultSiteSettings({ timezone: 'UTC', retentionDays: 90 }),
    });
    deliverer = fakeDeliverer(delivered);
    log = { lines: [] };
    deps = {
      store,
      deliver: deliverer,
      license: licensed,
      log: { info: (_d, m) => log.lines.push(m), warn: (_d, m) => log.lines.push(`warn: ${m}`) },
      publicUrl: 'https://analytics.example.test',
      now: () => clock,
    };
  });

  // Rows in the same clock hour on each of the four Thursdays before, and the
  // given number in the hour just completed.
  async function seedTraffic(thisHour: number, weeks: number[]): Promise<void> {
    const hourStart = Date.UTC(2026, 8, 24, 9);
    const rows: StoredEvent[] = [];
    weeks.forEach((count, week) => {
      for (let i = 0; i < count; i += 1) {
        rows.push(pageview(hourStart - (week + 1) * 7 * DAY_MS + i * 1000));
      }
    });
    for (let i = 0; i < thisHour; i += 1) {
      rows.push(pageview(hourStart + i * 1000));
    }
    await store.ingest(rows);
  }

  it('fires a traffic drop once, holds while it lasts, and says when it is back', async () => {
    await seedTraffic(40, [100, 110, 90, 105]);
    await store.createAlert(alertOf(DROP, 'Big drop'));

    const first = await runAlertsOnce(deps);
    expect(first).toMatchObject({ licensed: true, sites: 1, alerts: 1, claimed: 1, fired: 1, recovered: 0 });
    expect(deliverer.sent).toHaveLength(1);
    expect(deliverer.sent[0]?.message.subject).toBe('Chokh alert: Big drop on Example');
    expect(deliverer.sent[0]?.message.text).toBe(
      'Visitors on Example fell 61% in the hour to 10:00 UTC: 40 against a usual 103.\nhttps://analytics.example.test/s_alerts/alerts',
    );
    const row = await store.alert(SITE, alertIdFor(SITE, DROP));
    expect(row?.state).toEqual({ firing: true, since: NOW, checkedBucket: Math.floor(NOW / HOUR_MS) });
    expect(row?.recent).toEqual([
      { at: NOW, event: 'fired', value: 40, baseline: 102.5, deliveries: [{ channel: 'webhook', target: 'x', ok: true }] },
    ]);

    // The same hour again, from another process: the bucket is taken.
    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 0, fired: 0 });
    expect(deliverer.sent).toHaveLength(1);

    // The next hour, still low: nothing more is said.
    clock += HOUR_MS;
    const hourStart = Date.UTC(2026, 8, 24, 10);
    await store.ingest(Array.from({ length: 5 }, (_, i) => pageview(hourStart + i * 1000)));
    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 1, fired: 0, recovered: 0 });
    expect(deliverer.sent).toHaveLength(1);

    // Back: the same weekday hours a week ago and more held 0 rows at 11:00,
    // so seed those too and the recovery is measured, not assumed.
    clock += HOUR_MS;
    const eleven = Date.UTC(2026, 8, 24, 11);
    const rows: StoredEvent[] = [];
    for (let week = 1; week <= 4; week += 1) {
      for (let i = 0; i < 100; i += 1) rows.push(pageview(eleven - week * 7 * DAY_MS + i * 1000));
    }
    for (let i = 0; i < 95; i += 1) rows.push(pageview(eleven + i * 1000));
    await store.ingest(rows);
    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 1, fired: 0, recovered: 1 });
    expect(deliverer.sent[1]?.message.subject).toBe('Chokh: Big drop on Example is back to normal');
    expect(deliverer.sent[1]?.message.text).toContain('Back to normal. Visitors on Example fell 5% in the hour to 12:00 UTC: 95 against a usual 100.');
    const after = await store.alert(SITE, alertIdFor(SITE, DROP));
    expect(after?.state.firing).toBe(false);
    expect(after?.state.since).toBeUndefined();
    expect(after?.recent.map((each) => each.event)).toEqual(['fired', 'recovered']);
  });

  it('skips a traffic alert with one week of history', async () => {
    await seedTraffic(0, [100]);
    const alert = alertOf(DROP);
    await store.createAlert(alert);
    expect(await measure(store, (await store.site(SITE))!, alert, clock)).toBe(SKIPPED);
    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 1, skipped: 1, fired: 0 });
  });

  it('never speaks under the floor', async () => {
    // Nine pageviews against a usual three and a half is up 157%, on a site
    // where neither number reaches twenty.
    await seedTraffic(9, [3, 5, 4, 3]);
    const rise = alertOf({ kind: 'traffic', metric: 'pageviews', direction: 'up', percent: 100, minimum: 20 });
    expect(await measure(store, (await store.site(SITE))!, rise, clock)).toEqual({ firing: false, value: 9, baseline: 3.5 });
  });

  it('leaves a baseline hour outside retention out of the median', async () => {
    await store.updateSite(SITE, { settings: { retentionDays: 20 } });
    // Weeks 3 and 4 are 21 and 28 days back, outside 20 days of retention.
    await seedTraffic(10, [100, 100, 0, 0]);
    const alert = alertOf(DROP);
    const decision = await measure(store, (await store.site(SITE))!, alert, clock);
    expect(decision).toEqual({ firing: true, value: 10, baseline: 100 });
  });

  it('fires a goal count above, and below for a goal nobody reached', async () => {
    await store.createGoal({ siteId: SITE, id: SIGNUP, name: 'Signed up', kind: 'event', match: 'signup', createdBy: 'u_1', createdAt: NOW - DAY_MS });
    const rows: StoredEvent[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push(pageview(NOW - 30 * 60_000 + i * 1000, { type: 'event', name: 'signup', path: undefined }));
    }
    await store.ingest(rows);
    await store.createAlert(alertOf({ kind: 'goal', goalId: SIGNUP, direction: 'above', count: 10, window: 60 }, 'Signup rush'));
    await store.createAlert(alertOf({ kind: 'goal', goalId: SIGNUP, direction: 'below', count: 1, window: 1440 }, 'No signups'));
    await store.createAlert(alertOf({ kind: 'goal', goalId: 'g_gone', direction: 'below', count: 1, window: 60 }, 'Deleted goal'));

    const summary = await runAlertsOnce(deps);
    expect(summary).toMatchObject({ claimed: 3, fired: 1, skipped: 1 });
    expect(deliverer.sent).toHaveLength(1);
    expect(deliverer.sent[0]?.message.text).toContain('Signed up happened 12 times on Example in the last hour. The alert asks for 10 or more.');

    // A day with nothing in it: the below alert fires on the next tick.
    clock += 2 * DAY_MS;
    expect(await runAlertsOnce(deps)).toMatchObject({ fired: 1, recovered: 1 });
    // By name: "No signups" fires before "Signup rush" recovers.
    const texts = deliverer.sent.map((each) => each.message.text);
    expect(texts[1]).toContain('Signed up happened 0 times on Example in the last 24 hours. The alert asks for fewer than 1.');
    expect(texts[2]).toContain('Back to normal. Signed up happened 0 times');
  });

  it('counts an error burst by the class the page declared', async () => {
    const rows: StoredEvent[] = [];
    for (let i = 0; i < 6; i += 1) rows.push(pageview(NOW - 10 * 60_000 + i * 1000, { status: '500', path: '/checkout' }));
    for (let i = 0; i < 4; i += 1) rows.push(pageview(NOW - 9 * 60_000 + i * 1000, { status: '404', path: '/old' }));
    for (let i = 0; i < 50; i += 1) rows.push(pageview(NOW - 8 * 60_000 + i * 1000, { status: '200' }));
    await store.ingest(rows);
    await store.createAlert(alertOf({ kind: 'errors', statuses: '5xx', count: 5, window: 15 }, 'Server errors'));
    await store.createAlert(alertOf({ kind: 'errors', statuses: '4xx', count: 5, window: 15 }, 'Not found'));
    await store.createAlert(alertOf({ kind: 'errors', statuses: 'any', count: 10, window: 15 }, 'Any error'));

    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 3, fired: 2 });
    const subjects = deliverer.sent.map((each) => each.message.subject).sort();
    expect(subjects).toEqual(['Chokh alert: Any error on Example', 'Chokh alert: Server errors on Example']);
    expect(deliverer.sent.find((each) => each.message.subject.includes('Server'))?.message.text).toContain(
      '6 pages answered a 5xx on Example in the last 15 minutes. The alert asks for 5 or more.',
    );
  });

  it('calls silence on a site that went quiet, never on one that was never heard from', async () => {
    const silence: AlertCondition = { kind: 'silence', minutes: 30 };
    await store.createAlert(alertOf(silence, 'Gone quiet'));
    // Nothing at all: no alarm.
    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 1, fired: 0 });

    // Rows this morning, none in the last half hour.
    await store.ingest(Array.from({ length: 20 }, (_, i) => pageview(Date.UTC(2026, 8, 24, 8) + i * 1000)));
    clock += TICK_MS;
    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 1, fired: 1 });
    expect(deliverer.sent[0]?.message.text).toContain('No pageview on Example for 30 minutes.');

    // A visitor arrives: back.
    await store.ingest([pageview(clock - 1000)]);
    clock += TICK_MS;
    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 1, recovered: 1 });
    expect(deliverer.sent[1]?.message.text).toContain('Back to normal. 1 pageview on Example in the last 30 minutes.');
  });

  it('leaves the state where it was when nobody heard, and says it again next bucket', async () => {
    deliverer = fakeDeliverer(refused);
    deps.deliver = deliverer;
    await store.ingest(Array.from({ length: 20 }, (_, i) => pageview(Date.UTC(2026, 8, 24, 8) + i * 1000)));
    const silence: AlertCondition = { kind: 'silence', minutes: 30 };
    await store.createAlert(alertOf(silence, 'Gone quiet', [{ kind: 'email', to: 'ops@example.test' }, { kind: 'telegram', chatId: '1' }]));

    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 1, fired: 0, failed: 1 });
    let row = await store.alert(SITE, alertIdFor(SITE, silence));
    expect(row?.state.firing).toBe(false);
    expect(row?.recent).toHaveLength(1);
    expect(row?.recent[0]?.deliveries.map((each) => each.ok)).toEqual([false, false]);
    expect(log.lines).toContain('warn: alert not delivered');

    // One channel comes back: heard, and the episode begins.
    deps.deliver = fakeDeliverer((channel) => (channel.kind === 'telegram' ? delivered(channel) : refused(channel)));
    clock += TICK_MS;
    expect(await runAlertsOnce(deps)).toMatchObject({ claimed: 1, fired: 1, failed: 0 });
    row = await store.alert(SITE, alertIdFor(SITE, silence));
    expect(row?.state).toMatchObject({ firing: true, since: clock });
    expect(row?.recent[1]?.deliveries).toEqual([
      { channel: 'email', target: 'x', ok: false, error: 'down' },
      { channel: 'telegram', target: 'x', ok: true },
    ]);
  });

  it('reads nothing on an install with no licence', async () => {
    await store.createAlert(alertOf({ kind: 'silence', minutes: 30 }));
    deps.license = unlicensed;
    expect(await runAlertsOnce(deps)).toEqual({
      licensed: false,
      sites: 0,
      alerts: 0,
      claimed: 0,
      fired: 0,
      recovered: 0,
      skipped: 0,
      failed: 0,
    });
    expect((await store.alert(SITE, alertIdFor(SITE, { kind: 'silence', minutes: 30 })))?.state).toEqual({ firing: false });
  });
});
