import { describe, expect, it } from 'vitest';

import {
  resolveVisitorId,
  sendServerEvents,
  syntheticVisitorId,
} from './server-events.service.js';
import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';
import { defaultSiteSettings, type Site, type StoredEvent } from '../store/AnalyticsStore.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

const site: Site = {
  id: 's_one',
  name: 'One',
  domains: ['one.example'],
  teamId: 't_one',
  settings: defaultSiteSettings({ timezone: 'UTC' }),
};

async function open(): Promise<{ store: MemoryStore; deps: { store: MemoryStore; now(): number } }> {
  const store = createMemoryStore([], { now: () => NOW });
  await store.createSite(site);
  return { store, deps: { store, now: () => NOW } };
}

// A browser visit for this person, so the "last seen as" case has something to find.
function browserVisit(visitorId: string, userId?: string): StoredEvent[] {
  return [
    {
      siteId: site.id,
      ts: NOW - 60_000,
      receivedAt: NOW - 60_000,
      type: 'pageview',
      visitorId,
      path: '/checkout',
      bot: false,
      ...(userId === undefined ? {} : { userId }),
    },
  ];
}

describe('resolveVisitorId', () => {
  it('uses the id the application passed, which is the browser it is about', async () => {
    const { deps } = await open();
    expect(
      await resolveVisitorId(deps, site.id, { userId: 'u_42', visitorId: 'v_browser', events: [] }),
    ).toBe('v_browser');
  });

  it('falls back to the visitor this person was last seen as', async () => {
    const { store, deps } = await open();
    await store.ingest(browserVisit('v_known', 'u_42'));
    expect(await resolveVisitorId(deps, site.id, { userId: 'u_42', events: [] })).toBe('v_known');
  });

  // Somebody who only ever exists server side is still one visitor, not a new one
  // per event.
  it('falls back to a synthetic id derived from the userId', async () => {
    const { deps } = await open();
    expect(await resolveVisitorId(deps, site.id, { userId: 'u_new', events: [] })).toBe(
      syntheticVisitorId('u_new'),
    );
    expect(syntheticVisitorId('u_new')).toBe('u:u_new');
  });
});

describe('sendServerEvents', () => {
  it('lands on the stay the browser is in the middle of', async () => {
    const { store, deps } = await open();
    await store.ingest(browserVisit('v_known', 'u_42'));

    const result = await sendServerEvents(deps, site, {
      userId: 'u_42',
      events: [{ type: 'event', name: 'order_paid', value: 1200 }],
    });

    expect(result).toEqual({ accepted: 1, visitorId: 'v_known' });
    const stays = store.sessionsOf(site.id, 'v_known');
    expect(stays).toHaveLength(1);
    expect(stays[0]?.events).toBe(1);
    expect(stays[0]?.pageviews).toBe(1);
  });

  it('marks the row as server sent and keeps the trusted userId', async () => {
    const { store, deps } = await open();
    await sendServerEvents(deps, site, {
      userId: 'u_42',
      events: [{ type: 'event', name: 'signup' }],
    });
    const row = store.stored().find((event) => event.name === 'signup');
    expect(row?.source).toBe('server');
    expect(row?.userId).toBe('u_42');
    expect(row?.bot).toBe(false);
    // No address, ever: the stay it joins already has the visitor's geo from the
    // browser, and a backend guessing at one is how a country report ends up
    // showing a data centre.
    expect(row?.ip).toBeUndefined();
    expect(row?.geo).toBeUndefined();
  });

  it('leaves out an event on a path the site excludes, and strips its parameters', async () => {
    const { store, deps } = await open();
    await store.updateSite(site.id, {
      settings: { excludePaths: ['/internal/*'], excludeQueryParams: ['sid'] },
    });
    const excluding = await store.site(site.id);
    if (excluding === null) throw new Error('the site is gone');
    const result = await sendServerEvents(deps, excluding, {
      userId: 'u_42',
      events: [
        { type: 'event', name: 'health', path: '/internal/ping' },
        { type: 'event', name: 'order_paid', path: '/checkout?sid=abc&step=3' },
      ],
    });
    expect(result.accepted).toBe(1);
    const rows = store.stored().filter((event) => event.source === 'server');
    expect(rows.map((event) => [event.name, event.path])).toEqual([
      ['order_paid', '/checkout?step=3'],
    ]);
  });

  // A receipt written by a backend is not a sign that somebody is at a keyboard.
  it('puts nobody online', async () => {
    const { store, deps } = await open();
    await sendServerEvents(deps, site, {
      userId: 'u_42',
      events: [{ type: 'event', name: 'order_paid' }],
    });
    const snapshot = await store.realtime(site.id);
    expect(snapshot.online).toBe(0);
    expect(snapshot.visitors).toEqual([]);
  });

  it('does not take a browser visitor offline either', async () => {
    const { store, deps } = await open();
    // A pageview now, so they are online.
    await store.ingest([
      {
        siteId: site.id,
        ts: NOW - 10_000,
        receivedAt: NOW - 10_000,
        type: 'pageview',
        visitorId: 'v_live',
        userId: 'u_42',
        path: '/checkout',
        bot: false,
      },
    ]);
    expect((await store.realtime(site.id)).online).toBe(1);

    await sendServerEvents(deps, site, {
      userId: 'u_42',
      events: [{ type: 'event', name: 'order_paid' }],
    });

    expect((await store.realtime(site.id)).online).toBe(1);
  });

  it('carries traits on an identify onto the visitor', async () => {
    const { store, deps } = await open();
    await sendServerEvents(deps, site, {
      userId: 'u_42',
      events: [{ type: 'identify', traits: { plan: 'pro' } }],
    });
    const profile = await store.user(site.id, 'u_42');
    expect(profile?.traits).toEqual({ plan: 'pro' });
  });

  it('never dates an event after the moment it arrived', async () => {
    const { store, deps } = await open();
    await sendServerEvents(deps, site, {
      userId: 'u_42',
      events: [{ type: 'event', name: 'order_paid', ts: NOW + 86_400_000 }],
    });
    expect(store.stored()[0]?.ts).toBe(NOW);
  });
});
