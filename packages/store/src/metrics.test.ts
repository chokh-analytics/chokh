import { describe, expect, it } from 'vitest';

import {
  addEngagement,
  addLeave,
  finishEngagement,
  sortEngagementRows,
  zeroEngagement,
} from './metrics.js';

// The engagement arithmetic. It lives in the contract because two adapters
// must not disagree about what an average time on page is, and it is tested
// here because neither adapter can be asked about a leave beacon that carries
// only half of what it could carry: the collector never sends one, and the
// browser that does is a browser nobody has written yet.
describe('engagement arithmetic', () => {
  it('averages the leaves that carried a number and ignores the ones that did not', () => {
    const tally = zeroEngagement();
    addLeave(tally, { duration: 30_000, scrollDepth: 50 });
    addLeave(tally, { duration: 90_000 });
    addLeave(tally, { scrollDepth: 100 });
    const row = finishEngagement('/pricing', tally);
    // Two durations, not three: the leave with no duration is not a zero.
    expect(row.avgTimeOnPageMs).toBe(60_000);
    expect(row.avgScrollDepth).toBe(75);
    // Three leaves, because the sample size is the whole sample.
    expect(row.leaves).toBe(3);
  });

  it('answers null rather than zero for an average over nothing', () => {
    const tally = zeroEngagement();
    addLeave(tally, {});
    expect(finishEngagement('/', tally)).toEqual({
      key: '/',
      avgTimeOnPageMs: null,
      avgScrollDepth: null,
      leaves: 1,
    });
  });

  // A page somebody closed at once is a measurement, and a page nobody closed
  // is not. The two must not both read as zero seconds.
  it('keeps a measured zero apart from an unmeasured one', () => {
    const measured = zeroEngagement();
    addLeave(measured, { duration: 0, scrollDepth: 0 });
    expect(finishEngagement('/a', measured).avgTimeOnPageMs).toBe(0);
    expect(finishEngagement('/a', measured).avgScrollDepth).toBe(0);

    const unmeasured = zeroEngagement();
    addLeave(unmeasured, {});
    expect(finishEngagement('/b', unmeasured).avgTimeOnPageMs).toBeNull();
  });

  it('adds one tally into another the way an adapter folds its rows', () => {
    const into = zeroEngagement();
    addEngagement(into, { durationSum: 30_000, durationCount: 1, leaves: 1 });
    addEngagement(into, { durationSum: 90_000, durationCount: 1, scrollSum: 40, scrollCount: 1, leaves: 1 });
    expect(finishEngagement('/', into)).toEqual({
      key: '/',
      avgTimeOnPageMs: 60_000,
      avgScrollDepth: 40,
      leaves: 2,
    });
  });

  it('sorts most read first, then longest held, then by name', () => {
    const rows = sortEngagementRows([
      { key: '/b', avgTimeOnPageMs: 10_000, avgScrollDepth: null, leaves: 2 },
      { key: '/a', avgTimeOnPageMs: 20_000, avgScrollDepth: null, leaves: 2 },
      { key: '/c', avgTimeOnPageMs: null, avgScrollDepth: null, leaves: 9 },
      { key: '/d', avgTimeOnPageMs: 20_000, avgScrollDepth: null, leaves: 2 },
    ]);
    expect(rows.map((row) => row.key)).toEqual(['/c', '/a', '/d', '/b']);
  });
});
