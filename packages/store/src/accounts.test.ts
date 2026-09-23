import { describe, expect, it } from 'vitest';

import { funnelIdFor } from './accounts.js';
import type { FunnelStep } from './query.js';

// A funnel's id is its question. The cases here are the two ways a derived id
// can be wrong: two questions sharing one id, and one question getting two.

describe('funnelIdFor', () => {
  it('gives one question one id, whatever the steps are called or copied from', () => {
    const plain = funnelIdFor('s_1', '7d', [
      { kind: 'page', match: '/pricing' },
      { kind: 'event', match: 'signup' },
    ]);
    // A step as a funnel stores it, name and provenance included.
    const stored: FunnelStep[] = [
      { kind: 'page', match: '/pricing', name: 'Pricing' },
      { kind: 'event', match: 'signup', name: 'Signed up', goalId: 'g_signup' },
    ];
    const named = funnelIdFor('s_1', '7d', stored);
    expect(plain).toMatch(/^f_[A-Za-z0-9_-]{16}$/);
    expect(named).toBe(plain);
  });

  it('gives another site, another window or another order another id', () => {
    const steps = [
      { kind: 'page' as const, match: '/pricing' },
      { kind: 'event' as const, match: 'signup' },
    ];
    const base = funnelIdFor('s_1', '7d', steps);
    expect(funnelIdFor('s_2', '7d', steps)).not.toBe(base);
    expect(funnelIdFor('s_1', '1d', steps)).not.toBe(base);
    expect(funnelIdFor('s_1', '7d', [...steps].reverse())).not.toBe(base);
  });

  // The spelling this replaced joined a step's kind and match with a tab and
  // the steps with a newline, so one typed path holding both was the same
  // text as two steps. A path may hold any character, so that was reachable.
  it('never reads one step holding a tab and a newline as two steps', () => {
    const one = funnelIdFor('s_1', 'visit', [
      { kind: 'page', match: '/a\npage\t/b' },
      { kind: 'page', match: '/c' },
    ]);
    const two = funnelIdFor('s_1', 'visit', [
      { kind: 'page', match: '/a' },
      { kind: 'page', match: '/b' },
      { kind: 'page', match: '/c' },
    ]);
    expect(one).not.toBe(two);
  });
});
