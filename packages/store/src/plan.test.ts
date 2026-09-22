import { describe, expect, it } from 'vitest';

import { needsRawForInterval, readPlan } from './plan.js';

// Where a read gets its rows, and the one rule that decides it besides a
// filter: a bucket finer than a day cannot come out of a daily rollup.
//
// This lives in the contract because two adapters reaching different
// conclusions about it is how one of them draws a different chart from the
// other, which is exactly what happened: the MongoDB adapter planned a whole
// range without knowing the interval, found a rolled day and folded its total
// into the bucket the day begins in, so every Yesterday chart was one spike at
// midnight while the in-memory adapter answered real hours.

const DHAKA = 'Asia/Dhaka';
// 2026-09-18 10:00 in Dhaka.
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const TODAY_START = Date.UTC(2026, 8, 17, 18, 0, 0);
const YESTERDAY_START = Date.UTC(2026, 8, 16, 18, 0, 0);

function plan(over: Partial<Parameters<typeof readPlan>[0]> = {}) {
  return readPlan({
    from: YESTERDAY_START,
    to: TODAY_START,
    todayStart: TODAY_START,
    timezone: DHAKA,
    ...over,
  });
}

describe('needsRawForInterval', () => {
  it('knows which buckets a rollup cannot answer', () => {
    expect(needsRawForInterval('minute')).toBe(true);
    expect(needsRawForInterval('hour')).toBe(true);
    expect(needsRawForInterval('day')).toBe(false);
    expect(needsRawForInterval('week')).toBe(false);
    expect(needsRawForInterval('month')).toBe(false);
    // A read with no interval is a total, and a total is what a rollup is for.
    expect(needsRawForInterval(undefined)).toBe(false);
  });
});

describe('readPlan', () => {
  it('reads a whole past day out of its rollup when the bucket is a day', () => {
    expect(plan({ interval: 'day' })).toEqual({ days: ['2026-09-17'], raw: [] });
    expect(plan()).toEqual({ days: ['2026-09-17'], raw: [] });
  });

  // The fix. A rollup holds one number for the whole day and nothing that says
  // which hour of it anything happened in.
  it('reads the same day out of raw rows when the bucket is an hour', () => {
    expect(plan({ interval: 'hour' })).toEqual({
      days: [],
      raw: [{ from: YESTERDAY_START, to: TODAY_START }],
    });
  });

  it('reads it raw for a minute too', () => {
    expect(plan({ interval: 'minute' }).days).toEqual([]);
  });

  it('still splits a coarse read at the start of today', () => {
    const split = plan({ to: NOW, interval: 'day' });
    expect(split.days).toEqual(['2026-09-17']);
    expect(split.raw).toEqual([{ from: TODAY_START, to: NOW }]);
  });

  it('reads that same range entirely raw for an hourly bucket', () => {
    expect(plan({ to: NOW, interval: 'hour' })).toEqual({
      days: [],
      raw: [{ from: YESTERDAY_START, to: NOW }],
    });
  });

  // The rule it already had, unchanged: a rollup holds one dimension at a time
  // and never the cube.
  it('still falls back to raw for a filter no rollup can answer', () => {
    expect(
      plan({ interval: 'day', filters: [{ dim: 'page', op: 'is', value: '/pricing' }] }).days,
    ).toEqual([]);
  });
});

describe('a read counted against a goal', () => {
  // A rollup holds counts one dimension at a time and a conversion is an
  // overlap of two sets of people, so a goal read is raw for the whole range,
  // the visitors it divides by included.
  it('reads raw rows for a whole rolled day', () => {
    expect(plan({ goal: { kind: 'event', match: 'signup' } })).toEqual({
      days: [],
      raw: [{ from: YESTERDAY_START, to: TODAY_START }],
    });
    expect(plan().days).toEqual(['2026-09-17']);
  });
});
