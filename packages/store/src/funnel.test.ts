import { describe, expect, it } from 'vitest';

import { FUNNEL_SEQUENCE_COUNT, funnelSequences } from './conformance/funnel-sequences.js';
import {
  compareFunnelRows,
  finishFunnel,
  funnelDepth,
  funnelWindowMs,
  splitVisitFilters,
  type FunnelRow,
} from './funnel.js';

// The fold against the definition. funnelDepth keeps one number per step; the
// brute force below tries every chain there is, which is the definition in
// query.ts read literally: rows taken in funnel order, one row one step, the
// last step no later than the window after the first.

function bruteForce(rows: readonly FunnelRow[], windowMs: number): number {
  const steps = rows[0]?.hits.length ?? 0;
  let best = 0;
  const extend = (from: number, step: number, start: number): void => {
    best = Math.max(best, step);
    if (step === steps) return;
    for (let at = from; at < rows.length; at += 1) {
      const row = rows[at];
      if (row === undefined || row.hits[step] !== true) continue;
      const chainStart = step === 0 ? row.ts : start;
      if (row.ts - chainStart > windowMs) continue;
      extend(at + 1, step + 1, chainStart);
    }
  };
  extend(0, 0, 0);
  return best;
}

const MINUTE = 60_000;

function row(minute: number, ...hits: boolean[]): FunnelRow {
  return { ts: minute * MINUTE, hits };
}

describe('funnelDepth', () => {
  it(`agrees with every possible chain on ${FUNNEL_SEQUENCE_COUNT} seeded sequences`, () => {
    const sequences = funnelSequences();
    expect(sequences).toHaveLength(FUNNEL_SEQUENCE_COUNT);
    // The sequences are only a proof if they reach the hard cases.
    let ties = 0;
    let edges = 0;
    let deep = 0;
    for (const sequence of sequences) {
      const ordered = [...sequence.rows].sort(compareFunnelRows);
      const depth = funnelDepth(ordered, sequence.windowMs);
      expect(depth).toBe(bruteForce(ordered, sequence.windowMs));
      if (new Set(ordered.map((each) => each.ts)).size < ordered.length) ties += 1;
      if (ordered.some((a) => ordered.some((b) => b.ts - a.ts === sequence.windowMs))) edges += 1;
      if (depth >= 3) deep += 1;
    }
    expect(ties).toBeGreaterThan(100);
    expect(edges).toBeGreaterThan(100);
    expect(deep).toBeGreaterThan(50);
  });

  it('counts a last step exactly on the window and not a millisecond past it', () => {
    const window = 10 * MINUTE;
    expect(funnelDepth([row(0, true, false), row(10, false, true)], window)).toBe(2);
    expect(
      funnelDepth([row(0, true, false), { ts: 10 * MINUTE + 1, hits: [false, true] }], window),
    ).toBe(1);
  });

  it('chains rows at the same millisecond in step order', () => {
    const same = [row(5, false, true), row(5, true, false)].sort(compareFunnelRows);
    expect(same.map((each) => each.hits)).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(funnelDepth(same, MINUTE)).toBe(2);
  });

  it('never lets one row be two steps, even when it reaches both', () => {
    expect(funnelDepth([row(0, true, true)], MINUTE)).toBe(1);
    expect(funnelDepth([row(0, true, true), row(1, true, true)], 10 * MINUTE)).toBe(2);
  });

  it('ignores what happens between steps and counts a repeat once', () => {
    const rows = [
      row(0, true, false, false),
      row(1, false, true, false),
      row(2, true, false, false),
      row(3, false, false, true),
      row(4, false, false, true),
    ];
    expect(funnelDepth(rows, 10 * MINUTE)).toBe(3);
  });

  it('restarts the clock at a later first step without undoing an earlier chain', () => {
    const window = 60 * MINUTE;
    // The first chain reaches step 2 and runs out; the second, started later,
    // reaches step 3 within its own window.
    const first = row(0, true, false, false);
    const second = row(10, false, true, false);
    const third = row(150, false, false, true);
    const rows = [first, second, row(100, true, false, false), row(110, false, true, false), third];
    expect(funnelDepth(rows, window)).toBe(3);
    // Without the second start the third step is out of reach.
    expect(funnelDepth([first, second, third], window)).toBe(2);
  });

  it('answers nothing for nobody', () => {
    expect(funnelDepth([], MINUTE)).toBe(0);
  });

  it('gives a visit no bound beyond the visit', () => {
    expect(funnelWindowMs('visit')).toBe(Number.MAX_SAFE_INTEGER);
    expect(funnelWindowMs('7d')).toBe(7 * 24 * 60 * MINUTE);
  });
});

describe('finishFunnel', () => {
  it('turns who stopped where into who got how far, with drop-off and both rates', () => {
    const result = finishFunnel(
      [
        [0, 2],
        [1, 3],
        [2, 1],
        [3, 4],
      ],
      10,
      3,
    );
    expect(result).toEqual({
      visitors: 10,
      rawOnly: true,
      steps: [
        { visitors: 8, dropOff: 0, rate: 1, stepRate: null },
        { visitors: 5, dropOff: 3, rate: 5 / 8, stepRate: 5 / 8 },
        { visitors: 4, dropOff: 1, rate: 0.5, stepRate: 0.8 },
      ],
    });
  });

  it('says nothing over nobody', () => {
    expect(finishFunnel([], 0, 2).steps).toEqual([
      { visitors: 0, dropOff: 0, rate: null, stepRate: null },
      { visitors: 0, dropOff: 0, rate: null, stepRate: null },
    ]);
  });
});

describe('splitVisitFilters', () => {
  it('sends entry, exit and channel to the stays, the bot filter nowhere, the rest to the rows', () => {
    expect(
      splitVisitFilters([
        { dim: 'channel', op: 'is', value: 'social' },
        { dim: 'country', op: 'is', value: 'BD' },
        { dim: 'bot', op: 'is', value: 'true' },
        { dim: 'entry', op: 'contains', value: '/docs' },
      ]),
    ).toEqual({
      event: [{ dim: 'country', op: 'is', value: 'BD' }],
      stay: [
        { dim: 'channel', op: 'is', value: 'social' },
        { dim: 'entry', op: 'contains', value: '/docs' },
      ],
    });
  });
});
