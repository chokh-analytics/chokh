import { describe, expect, it } from 'vitest';

import { comparisonRange } from './query.js';

// Where a comparison reads from, which is arithmetic and belongs in the
// contract: a comparison that means one thing in memory and another in MongoDB
// is the bug the read plan already taught this codebase once.

const DHAKA = 'Asia/Dhaka';
const DAY = 24 * 60 * 60 * 1000;

// The shape every preset has: a midnight to a mid-afternoon now. 2026-09-18
// 10:00 in Dhaka, with a window opening at the Dhaka midnight seven days back.
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const TODAY_START = Date.UTC(2026, 8, 17, 18, 0, 0);
const WEEK = { from: TODAY_START - 6 * DAY, to: NOW };

describe('comparisonRange, previous_period', () => {
  // The bug: subtracting the length of a window that ends at 10am lands the
  // previous window at 10am, so its first bucket is the fourteen hours after
  // that instant and every bucket after it is offset by the same fraction of a
  // day. On screen the dashed line opens at a sliver against a whole day.
  it('starts and ends on a day boundary for a day series', () => {
    const previous = comparisonRange(WEEK, 'previous_period', DHAKA, 'day');
    expect(previous.to).toBe(WEEK.from);
    expect((previous.to - previous.from) % DAY).toBe(0);
    expect(previous.from).toBe(WEEK.from - 7 * DAY);
  });

  it('counts the same days a week and a month series do', () => {
    for (const interval of ['week', 'month'] as const) {
      const previous = comparisonRange(WEEK, 'previous_period', DHAKA, interval);
      expect(previous.from, interval).toBe(WEEK.from - 7 * DAY);
    }
  });

  // Which is not what a length subtraction gives: it lands mid-day, and the
  // difference is the fourteen hours this window has already run.
  it('is not the same as subtracting the length', () => {
    const previous = comparisonRange(WEEK, 'previous_period', DHAKA, 'day');
    const bySubtraction = { from: WEEK.from - (WEEK.to - WEEK.from), to: WEEK.from };
    expect(previous.from).not.toBe(bySubtraction.from);
    expect(bySubtraction.from % DAY).not.toBe(previous.from % DAY);
  });

  // An hourly window has no such problem, and rounding it to days would compare
  // two hours of this morning against a whole day.
  it('keeps the exact length for an hour and a minute series', () => {
    for (const interval of ['hour', 'minute'] as const) {
      const range = { from: NOW - 2 * 60 * 60 * 1000, to: NOW };
      const previous = comparisonRange(range, 'previous_period', DHAKA, interval);
      expect(previous, interval).toEqual({ from: NOW - 4 * 60 * 60 * 1000, to: range.from });
    }
  });

  it('keeps the exact length when nobody said what the buckets are', () => {
    expect(comparisonRange(WEEK, 'previous_period', DHAKA)).toEqual({
      from: WEEK.from - (WEEK.to - WEEK.from),
      to: WEEK.from,
    });
  });

  // Today alone: one calendar day, so one calendar day before it.
  it('answers one whole day for a window inside one day', () => {
    const today = { from: TODAY_START, to: NOW };
    expect(comparisonRange(today, 'previous_period', DHAKA, 'day')).toEqual({
      from: TODAY_START - DAY,
      to: TODAY_START,
    });
  });

  // The days are the site's own. WEEK opens on a Dhaka midnight, which is
  // 18:00 the day before in UTC, so a UTC site reading the same two instants
  // lands on different boundaries, and that difference is the whole reason the
  // zone is an argument.
  it('draws its day boundaries in the site zone', () => {
    const inDhaka = comparisonRange(WEEK, 'previous_period', DHAKA, 'day');
    const inUtc = comparisonRange(WEEK, 'previous_period', 'UTC', 'day');
    expect(inUtc.from).not.toBe(inDhaka.from);
    // Both still land on a midnight of their own calendar.
    expect(inUtc.to).toBe(Date.UTC(2026, 8, 11, 0, 0, 0));
    expect(inDhaka.to).toBe(WEEK.from);
  });

  // A window that does not begin at a midnight still compares against whole
  // days, because the chart's own first bucket is the whole day it falls in:
  // the two have to be cut the same way or bucket one is not bucket one.
  it('snaps a mid-day window back to the day its first bucket covers', () => {
    const odd = { from: TODAY_START + 5 * 60 * 60 * 1000, to: NOW };
    const previous = comparisonRange(odd, 'previous_period', DHAKA, 'day');
    expect(previous.to).toBe(TODAY_START);
    expect(previous.from).toBe(TODAY_START - DAY);
  });
});

describe('comparisonRange, previous_year', () => {
  // The same wall clock a year earlier, which is not the same number of
  // milliseconds and is the point of asking for it.
  it('shifts the clock rather than subtracting a length', () => {
    const previous = comparisonRange(WEEK, 'previous_year', DHAKA, 'day');
    expect(new Date(previous.from).getUTCFullYear()).toBe(2025);
    expect(new Date(previous.to).getUTCFullYear()).toBe(2025);
  });

  it('is the same whatever the buckets are', () => {
    const byDay = comparisonRange(WEEK, 'previous_year', DHAKA, 'day');
    expect(comparisonRange(WEEK, 'previous_year', DHAKA, 'hour')).toEqual(byDay);
    expect(comparisonRange(WEEK, 'previous_year', DHAKA)).toEqual(byDay);
  });
});
