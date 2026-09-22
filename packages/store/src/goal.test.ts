import { describe, expect, it } from 'vitest';

import { conversionMatcher, finishConversion, goalIsPattern, goalPattern } from './query.js';
import type { StoredEvent } from './types.js';

// What reaches a goal, decided in the contract so both adapters count the same
// rows: the in-memory one tests them with conversionMatcher and MongoDB is handed
// goalPattern as its $regex.

function row(over: Partial<StoredEvent>): StoredEvent {
  return {
    siteId: 's',
    ts: 0,
    receivedAt: 0,
    type: 'pageview',
    visitorId: 'v',
    bot: false,
    ...over,
  };
}

describe('goalPattern', () => {
  it('lets a star stand for one segment of a path and nothing more', () => {
    const pattern = new RegExp(goalPattern('/*/checkout/done'));
    expect(pattern.test('/en/checkout/done')).toBe(true);
    expect(pattern.test('/bn/checkout/done')).toBe(true);
    expect(pattern.test('/checkout/done')).toBe(false);
    expect(pattern.test('/a/b/checkout/done')).toBe(false);
    expect(pattern.test('/en/checkout/done/again')).toBe(false);
  });

  it('means a dot and a bracket literally', () => {
    const pattern = new RegExp(goalPattern('/files/report.pdf'));
    expect(pattern.test('/files/report.pdf')).toBe(true);
    expect(pattern.test('/files/reportXpdf')).toBe(false);
    expect(new RegExp(goalPattern('/a[1]')).test('/a[1]')).toBe(true);
  });

  it('knows a plain path needs no pattern', () => {
    expect(goalIsPattern({ kind: 'page', match: '/pricing' })).toBe(false);
    expect(goalIsPattern({ kind: 'page', match: '/*/pricing' })).toBe(true);
    // An event name is always matched exactly, a star included.
    expect(goalIsPattern({ kind: 'event', match: 'sign*' })).toBe(false);
  });
});

describe('conversionMatcher', () => {
  it('counts a pageview of the page and nothing else that happened on it', () => {
    const reached = conversionMatcher({ kind: 'page', match: '/pricing' });
    expect(reached(row({ path: '/pricing' }))).toBe(true);
    expect(reached(row({ path: '/pricing', type: 'leave' }))).toBe(false);
    expect(reached(row({ path: '/pricing', type: 'event', name: 'click' }))).toBe(false);
    expect(reached(row({ path: '/pricing/team' }))).toBe(false);
  });

  it('counts a custom event of that exact name, a server one included, and not a page timing', () => {
    const reached = conversionMatcher({ kind: 'event', match: 'signup' });
    expect(reached(row({ type: 'event', name: 'signup' }))).toBe(true);
    expect(reached(row({ type: 'event', name: 'signup', source: 'server' }))).toBe(true);
    expect(reached(row({ type: 'event', name: 'signup_started' }))).toBe(false);
    expect(reached(row({ type: 'vital', name: 'signup' }))).toBe(false);
  });

  it('matches a pattern page goal against the path', () => {
    const reached = conversionMatcher({ kind: 'page', match: '/*/done' });
    expect(reached(row({ path: '/en/done' }))).toBe(true);
    expect(reached(row({}))).toBe(false);
  });
});

describe('finishConversion', () => {
  it('rates over the row and prices completions, and says nothing over nobody', () => {
    expect(
      finishConversion({ visitors: 2, completions: 3 }, 8, { kind: 'event', match: 's', value: 5 }),
    ).toEqual({ visitors: 2, completions: 3, rate: 0.25, value: 15 });
    expect(finishConversion({ visitors: 0, completions: 0 }, 0, { kind: 'event', match: 's' })).toEqual(
      { visitors: 0, completions: 0, rate: null, value: null },
    );
  });
});
