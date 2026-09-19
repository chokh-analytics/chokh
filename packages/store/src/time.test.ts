import { describe, expect, it } from 'vitest';

import { bucketIndexAt, bucketStart, bucketsBetween } from './time.js';

// The fold that lets a time series be read in one query instead of one per
// bucket. Every other part of time.ts is proved through the conformance suite,
// which asks both adapters the same questions about day boundaries; this one is
// pure arithmetic that no adapter can disagree about, so it is tested here.
describe('bucketIndexAt', () => {
  const DHAKA = 'Asia/Dhaka';
  // Three days of a UTC+6 calendar: the 16th, 17th and 18th of September 2026.
  const from = Date.UTC(2026, 8, 15, 18, 0, 0);
  const to = Date.UTC(2026, 8, 18, 18, 0, 0);
  const days = bucketsBetween(from, to, 'day', DHAKA);

  it('puts an instant in the bucket that holds it', () => {
    expect(days).toHaveLength(3);
    expect(bucketIndexAt(days, days[0]!, to)).toBe(0);
    expect(bucketIndexAt(days, days[1]!, to)).toBe(1);
    expect(bucketIndexAt(days, days[2]!, to)).toBe(2);
    expect(bucketIndexAt(days, days[1]! + 3_600_000, to)).toBe(1);
    // The last millisecond of a bucket is still that bucket's.
    expect(bucketIndexAt(days, days[1]! - 1, to)).toBe(0);
  });

  it('drops an instant outside the range rather than folding it into an edge', () => {
    expect(bucketIndexAt(days, from - 1, to)).toBe(-1);
    expect(bucketIndexAt(days, to, to)).toBe(-1);
    expect(bucketIndexAt([], from, to)).toBe(-1);
  });

  // A week or a month bucket holds many days, and the pipelines group by day, so
  // the fold is what makes those intervals one query as well.
  it('folds every day of a week into the one bucket', () => {
    const start = Date.UTC(2026, 8, 6, 18, 0, 0);
    const end = Date.UTC(2026, 8, 20, 18, 0, 0);
    const weeks = bucketsBetween(start, end, 'week', DHAKA);
    expect(weeks).toHaveLength(2);
    const eachDay = bucketsBetween(start, end, 'day', DHAKA);
    expect(eachDay).toHaveLength(14);
    const perWeek = [0, 0];
    for (const day of eachDay) {
      const index = bucketIndexAt(weeks, day, end);
      expect(index).not.toBe(-1);
      perWeek[index] = (perWeek[index] ?? 0) + 1;
    }
    expect(perWeek).toEqual([7, 7]);
  });

  it('finds the right bucket in a long series', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const end = Date.UTC(2026, 3, 1, 0, 0, 0);
    const starts = bucketsBetween(start, end, 'day', 'UTC');
    expect(starts).toHaveLength(90);
    for (const [index, at] of starts.entries()) {
      expect(bucketIndexAt(starts, at, end)).toBe(index);
      expect(bucketIndexAt(starts, at + 12 * 3_600_000, end)).toBe(index);
    }
  });
});

// The live view's interval. A minute is the one bucket whose boundary is the
// same in almost every zone, which is exactly why it is worth asserting that
// it still goes through the zone rather than around it.
describe('minute buckets', () => {
  const DHAKA = 'Asia/Dhaka';
  const KATHMANDU = 'Asia/Kathmandu';

  it('cuts to the start of the minute and drops the seconds', () => {
    const ts = Date.UTC(2026, 8, 18, 4, 17, 42, 500);
    expect(bucketStart(ts, 'minute', DHAKA)).toBe(Date.UTC(2026, 8, 18, 4, 17, 0, 0));
  });

  it('lands on the same minute in a zone whose hours do not line up with UTC', () => {
    // Kathmandu is UTC+5:45. Its hour buckets start a quarter of an hour off
    // UTC's and its minute buckets do not, which is the point: every modern
    // zone is a whole number of minutes from UTC, so a minute is a minute
    // everywhere, and a series can be read without asking which zone it is in.
    const ts = Date.UTC(2026, 8, 18, 4, 17, 30);
    expect(bucketStart(ts, 'minute', KATHMANDU)).toBe(Date.UTC(2026, 8, 18, 4, 17, 0));
    expect(bucketStart(ts, 'minute', DHAKA)).toBe(Date.UTC(2026, 8, 18, 4, 17, 0));
    expect(bucketStart(ts, 'hour', KATHMANDU)).toBe(Date.UTC(2026, 8, 18, 4, 15, 0));
    expect(bucketStart(ts, 'hour', DHAKA)).toBe(Date.UTC(2026, 8, 18, 4, 0, 0));
  });

  it('walks a half hour a minute at a time', () => {
    const to = Date.UTC(2026, 8, 18, 4, 0, 0);
    const from = to - 30 * 60_000;
    const starts = bucketsBetween(from, to, 'minute', DHAKA);
    expect(starts).toHaveLength(30);
    expect(starts[0]).toBe(from);
    expect(starts[29]).toBe(to - 60_000);
    for (const [index, at] of starts.entries()) {
      expect(bucketIndexAt(starts, at, to)).toBe(index);
      expect(bucketIndexAt(starts, at + 59_999, to)).toBe(index);
    }
  });
});
