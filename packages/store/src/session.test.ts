import { describe, expect, it } from 'vitest';

import {
  SESSION_GAP_MS,
  foldVisitor,
  groupForFold,
  isBounce,
  isEphemeral,
  sessionIdFor,
} from './session.js';
import type { StoredEvent, StoredSession, StoredVisitor } from './types.js';

const SITE = 'site_1';
const VISITOR = 'v1';
const START = Date.UTC(2026, 8, 18, 9, 0, 0);

function event(offsetMs: number, over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    siteId: SITE,
    ts: START + offsetMs,
    receivedAt: START + offsetMs,
    type: 'pageview',
    visitorId: VISITOR,
    bot: false,
    hostname: 'shop.test',
    ...over,
  };
}

function fold(events: StoredEvent[], open: StoredSession | null = null, visitor: StoredVisitor | null = null) {
  return foldVisitor({ siteId: SITE, visitorId: VISITOR, events, open, visitor });
}

describe('the gap rule', () => {
  it('keeps events with no thirty minute gap in one stay', () => {
    const result = fold([event(0, { path: '/a' }), event(29 * 60_000, { path: '/b' })]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.pageviews).toBe(2);
    expect(result.sessions[0]?.duration).toBe(29 * 60_000);
  });

  it('starts a new stay at exactly thirty minutes', () => {
    const result = fold([event(0, { path: '/a' }), event(SESSION_GAP_MS, { path: '/b' })]);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((session) => session.pageviews)).toEqual([1, 1]);
  });

  it('measures the gap from the last sign of life, not from the start', () => {
    // Twenty minutes, then twenty more: eighty minutes of stay, one session,
    // because the visitor never went quiet for half an hour.
    const result = fold([
      event(0, { path: '/a' }),
      event(20 * 60_000, { path: '/b' }),
      event(40 * 60_000, { path: '/c' }),
      event(60 * 60_000, { path: '/d' }),
    ]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.duration).toBe(60 * 60_000);
  });

  it('carries on the stay a previous batch left open', () => {
    const first = fold([event(0, { path: '/a' })]);
    const open = first.sessions[0];
    const second = fold([event(10 * 60_000, { path: '/b' })], open ?? null, first.visitor);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]?.id).toBe(open?.id);
    expect(second.sessions[0]?.pageviews).toBe(2);
    expect(second.visitor.sessions).toBe(1);
  });

  it('opens a new one when the visitor comes back the next day', () => {
    const first = fold([event(0, { path: '/a' })]);
    const second = fold([event(24 * 3600_000, { path: '/b' })], first.sessions[0] ?? null, first.visitor);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]?.id).not.toBe(first.sessions[0]?.id);
    expect(second.sessions[0]?.isNew).toBe(false);
    expect(second.visitor.sessions).toBe(2);
  });

  it('gives the same stay the same id, so a batch sent twice is not two visits', () => {
    expect(sessionIdFor(SITE, VISITOR, START)).toBe(sessionIdFor(SITE, VISITOR, START));
    expect(sessionIdFor(SITE, VISITOR, START)).not.toBe(sessionIdFor(SITE, 'v2', START));
    const once = fold([event(0, { path: '/a' })]);
    const twice = fold([event(0, { path: '/a' })]);
    expect(twice.sessions[0]?.id).toBe(once.sessions[0]?.id);
  });

  it('sorts a batch that arrives out of order', () => {
    const result = fold([event(60_000, { path: '/b' }), event(0, { path: '/a' })]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.startedAt).toBe(START);
    expect(result.sessions[0]?.entryPath).toBe('/a');
    expect(result.sessions[0]?.exitPath).toBe('/b');
  });
});

describe('what a stay records', () => {
  it('remembers where it came in and where it got to', () => {
    const result = fold([
      event(0, { path: '/home', referrer: 'https://www.google.com/' }),
      event(60_000, { path: '/pricing' }),
      event(120_000, { type: 'heartbeat', path: '/pricing' }),
    ]);
    const session = result.sessions[0];
    expect(session?.entryPath).toBe('/home');
    expect(session?.exitPath).toBe('/pricing');
    expect(session?.pageviews).toBe(2);
    expect(session?.channel).toBe('organic');
    expect(session?.referrer).toBe('https://www.google.com/');
  });

  it('counts custom events apart from pageviews', () => {
    const result = fold([
      event(0, { path: '/home' }),
      event(1000, { type: 'event', name: 'signup' }),
    ]);
    expect(result.sessions[0]?.pageviews).toBe(1);
    expect(result.sessions[0]?.events).toBe(1);
  });

  it('takes the source from the first event and not the last', () => {
    // A referrer only reaches the tracker on the first pageview of a load, and
    // a campaign is the link that was clicked, not the page read last.
    const result = fold([
      event(0, { path: '/home', utm: { source: 'facebook', medium: 'social' } }),
      event(60_000, { path: '/pricing', referrer: 'https://elsewhere.test/' }),
    ]);
    expect(result.sessions[0]?.channel).toBe('social');
    expect(result.sessions[0]?.utm).toEqual({ source: 'facebook', medium: 'social' });
  });

  it('is ended by a leave beacon', () => {
    const result = fold([
      event(0, { path: '/home' }),
      event(30_000, { type: 'leave', path: '/home', duration: 30_000, scrollDepth: 75 }),
    ]);
    expect(result.sessions[0]?.endedAt).toBe(START + 30_000);
    expect(result.sessions[0]?.duration).toBe(30_000);
  });

  it('bounces when one page or none was read', () => {
    const one = fold([event(0, { path: '/home' })]);
    expect(isBounce(one.sessions[0] as StoredSession)).toBe(true);
    const none = fold([event(0, { type: 'event', name: 'signup' })]);
    expect(isBounce(none.sessions[0] as StoredSession)).toBe(true);
    const two = fold([event(0, { path: '/a' }), event(1000, { path: '/b' })]);
    expect(isBounce(two.sessions[0] as StoredSession)).toBe(false);
  });

  it('marks the first stay of a visitor and nothing after it', () => {
    const first = fold([event(0, { path: '/a' })]);
    expect(first.sessions[0]?.isNew).toBe(true);
    const later = fold([event(3600_000, { path: '/b' })], first.sessions[0] ?? null, first.visitor);
    expect(later.sessions[0]?.isNew).toBe(false);
  });

  it('is a crawler stay when the event that opened it was tagged one', () => {
    const result = fold([event(0, { path: '/a', bot: true })]);
    expect(result.sessions[0]?.bot).toBe(true);
  });
});

describe('a heartbeat', () => {
  it('is the only ephemeral event', () => {
    expect(isEphemeral(event(0, { type: 'heartbeat' }))).toBe(true);
    for (const type of ['pageview', 'event', 'leave', 'identify', 'vital'] as const) {
      expect(isEphemeral(event(0, { type }))).toBe(false);
    }
  });

  it('moves the stay and is then thrown away', () => {
    const result = fold([
      event(0, { path: '/a' }),
      event(20_000, { type: 'heartbeat', path: '/a' }),
      event(40_000, { type: 'heartbeat', path: '/b' }),
    ]);

    // One row to store, and it is the pageview.
    expect(result.events.map((one) => one.type)).toEqual(['pageview']);
    // The stay heard all three.
    const session = result.sessions[0];
    expect(session?.lastSeenAt).toBe(START + 40_000);
    expect(session?.duration).toBe(40_000);
    expect(session?.exitPath).toBe('/b');
    expect(session?.pageviews).toBe(1);
  });

  it('can be a whole batch and still leave nothing to store', () => {
    const first = fold([event(0, { path: '/a' })]);
    const second = fold(
      [event(60_000, { type: 'heartbeat', path: '/a' })],
      first.sessions[0] ?? null,
      first.visitor,
    );

    expect(second.events).toEqual([]);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]?.lastSeenAt).toBe(START + 60_000);
    expect(second.visitor.lastSeenAt).toBe(START + 60_000);
  });

  it('still opens a stay of its own after a gap, so a returning tab is seen', () => {
    const first = fold([event(0, { path: '/a' })]);
    const second = fold(
      [event(2 * SESSION_GAP_MS, { type: 'heartbeat', path: '/a' })],
      first.sessions[0] ?? null,
      first.visitor,
    );

    expect(second.events).toEqual([]);
    expect(second.visitor.sessions).toBe(2);
    expect(second.sessions[0]?.pageviews).toBe(0);
  });

  it('keeps a leave beacon, which carries the time on page', () => {
    const result = fold([
      event(0, { path: '/a' }),
      event(20_000, { type: 'heartbeat', path: '/a' }),
      event(30_000, { type: 'leave', path: '/a', duration: 30_000, scrollDepth: 75 }),
    ]);

    expect(result.events.map((one) => one.type)).toEqual(['pageview', 'leave']);
    expect(result.events[1]?.duration).toBe(30_000);
    expect(result.events[1]?.scrollDepth).toBe(75);
  });
});

describe('the visitor row', () => {
  it('counts stays and pageviews across batches', () => {
    const first = fold([event(0, { path: '/a' }), event(60_000, { path: '/b' })]);
    expect(first.visitor.sessions).toBe(1);
    expect(first.visitor.pageviews).toBe(2);
    const second = fold([event(3600_000, { path: '/c' })], first.sessions[0] ?? null, first.visitor);
    expect(second.visitor.sessions).toBe(2);
    expect(second.visitor.pageviews).toBe(3);
    expect(second.visitor.firstSeenAt).toBe(START);
    expect(second.visitor.lastSeenAt).toBe(START + 3600_000);
  });

  it('writes first touch once and last touch every time', () => {
    const first = fold([event(0, { path: '/a', referrer: 'https://www.google.com/' })]);
    expect(first.visitor.firstTouch?.channel).toBe('organic');
    expect(first.visitor.lastTouch?.channel).toBe('organic');

    const second = fold(
      [event(3600_000, { path: '/b', utm: { medium: 'cpc' } })],
      first.sessions[0] ?? null,
      first.visitor,
    );
    expect(second.visitor.firstTouch?.channel).toBe('organic');
    expect(second.visitor.firstTouch?.at).toBe(START);
    expect(second.visitor.lastTouch?.channel).toBe('paid');
    expect(second.visitor.lastTouch?.at).toBe(START + 3600_000);
  });

  it('leaves last touch alone when a batch only extends the open stay', () => {
    const first = fold([event(0, { path: '/a', referrer: 'https://www.google.com/' })]);
    const second = fold([event(60_000, { path: '/b' })], first.sessions[0] ?? null, first.visitor);
    expect(second.visitor.lastTouch?.channel).toBe('organic');
  });

  it('calls home the place most of their stays came from', () => {
    const dhaka = { country: 'BD', region: 'Dhaka', city: 'Dhaka' };
    const kolkata = { country: 'IN', region: 'West Bengal', city: 'Kolkata' };
    let state = fold([event(0, { path: '/a', geo: dhaka })]);
    let open = state.sessions[0] ?? null;
    for (const [index, geo] of [kolkata, dhaka].entries()) {
      state = fold([event((index + 1) * 3600_000, { path: '/a', geo })], open, state.visitor);
      open = state.sessions[0] ?? null;
    }
    expect(state.visitor.homeGeo?.city).toBe('Dhaka');
    expect(state.visitor.places.find((place) => place.geo.city === 'Dhaka')?.count).toBe(2);
  });
});

describe('the merge', () => {
  const named = { userId: 'u_rafi', traits: { plan: 'pro' } };

  it('names every event of the batch, including the ones before the identify', () => {
    const result = fold([
      event(0, { path: '/home' }),
      event(60_000, { type: 'identify', ...named }),
      event(120_000, { path: '/account' }),
    ]);
    expect(result.events.map((one) => one.userId)).toEqual(['u_rafi', 'u_rafi', 'u_rafi']);
    expect(result.sessions[0]?.userId).toBe('u_rafi');
    expect(result.visitor.userId).toBe('u_rafi');
    expect(result.visitor.traits).toEqual({ plan: 'pro' });
  });

  it('asks for the earlier rows to be named too, once and only once', () => {
    const first = fold([event(0, { path: '/home' })]);
    expect(first.merge).toBeUndefined();

    const second = fold(
      [event(3600_000, { type: 'identify', ...named })],
      first.sessions[0] ?? null,
      first.visitor,
    );
    expect(second.merge).toBe('u_rafi');

    const third = fold(
      [event(7200_000, { path: '/account', userId: 'u_rafi' })],
      second.sessions[0] ?? null,
      second.visitor,
    );
    // Already theirs, so nothing is rewritten a second time.
    expect(third.merge).toBeUndefined();
  });

  it('keeps naming a visitor a batch forgot to name', () => {
    // The tracker forgets the userId on a reload; the visitor id survives it.
    const first = fold([event(0, { type: 'identify', ...named })]);
    const second = fold([event(3600_000, { path: '/home' })], first.sessions[0] ?? null, first.visitor);
    expect(second.events[0]?.userId).toBe('u_rafi');
    expect(second.visitor.userId).toBe('u_rafi');
  });

  it('does not hand one person another person history on a shared computer', () => {
    const first = fold([event(0, { path: '/home', type: 'identify', ...named })]);
    const second = fold(
      [event(3600_000, { type: 'identify', userId: 'u_mim' })],
      first.sessions[0] ?? null,
      first.visitor,
    );
    // The visitor answers to the new name from here on, and nothing before it
    // is rewritten: those stays were somebody else's.
    expect(second.visitor.userId).toBe('u_mim');
    expect(second.merge).toBeUndefined();
  });
});

describe('groupForFold', () => {
  it('splits a batch by site and visitor', () => {
    const groups = groupForFold([
      event(0),
      event(1000, { visitorId: 'v2' }),
      event(2000),
      event(3000, { siteId: 'site_2' }),
    ]);
    expect(groups.size).toBe(3);
    expect(groups.get(`${SITE}\n${VISITOR}`)).toHaveLength(2);
  });
});
