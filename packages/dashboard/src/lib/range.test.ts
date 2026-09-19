import { describe, expect, it } from 'vitest';

import {
  allowedIntervals,
  comparisonRange,
  customRange,
  defaultInterval,
  isLive,
  isPreset,
  MAX_RANGE_MS,
  rangeProblem,
  resolvePreset,
  shiftRange,
  type DateRange,
} from './range.js';

// The site is in Dhaka, six hours ahead of UTC, and this process is in whatever
// zone the machine running the tests is in. None of these answers may depend on
// that: a range built in the browser's zone is the truncated leading bucket
// that reads on a chart as a drop in traffic.
const DHAKA = 'Asia/Dhaka';

// 2026-09-18 10:00 in Dhaka, which is 04:00 UTC.
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const TODAY_START = Date.UTC(2026, 8, 17, 18, 0, 0);
const YESTERDAY_START = Date.UTC(2026, 8, 16, 18, 0, 0);

describe('resolvePreset', () => {
  it('starts today at the site midnight and not at the browser one', () => {
    const range = resolvePreset('today', NOW, DHAKA);
    expect(range.from).toBe(TODAY_START);
    expect(range.to).toBe(NOW);
    // The same instant in UTC is a different day and a different boundary,
    // which is the whole reason the zone is passed in.
    expect(resolvePreset('today', NOW, 'UTC').from).toBe(Date.UTC(2026, 8, 18, 0, 0, 0));
  });

  // The one window whose number stops moving once it is drawn, which is why
  // somebody picks it. Running it to the start of tomorrow would leave it
  // ticking, and a yesterday that keeps changing is not yesterday.
  it('ends yesterday at this morning and never at tomorrow', () => {
    const range = resolvePreset('yesterday', NOW, DHAKA);
    expect(range.from).toBe(YESTERDAY_START);
    expect(range.to).toBe(TODAY_START);
  });

  it('counts a seven day window as seven site days ending now', () => {
    const range = resolvePreset('7d', NOW, DHAKA);
    expect(range.to).toBe(NOW);
    // Six whole days behind today, plus today, is seven.
    expect(range.from).toBe(TODAY_START - 6 * 24 * 60 * 60 * 1000);
  });

  it('counts a thirty day window the same way', () => {
    const range = resolvePreset('30d', NOW, DHAKA);
    expect(range.from).toBe(TODAY_START - 29 * 24 * 60 * 60 * 1000);
  });

  it('falls back to a week when a URL says custom and carries no dates', () => {
    expect(resolvePreset('custom', NOW, DHAKA).from).toBe(resolvePreset('7d', NOW, DHAKA).from);
  });

  it('knows which words are presets', () => {
    expect(isPreset('30d')).toBe(true);
    expect(isPreset('90d')).toBe(false);
    expect(isPreset(undefined)).toBe(false);
  });
});

describe('customRange', () => {
  // Outward on both ends, so neither edge of the chart is half a day of
  // traffic drawn as a whole one.
  it('snaps a pair of dates out to whole site days', () => {
    const range = customRange('2026-09-16', '2026-09-17', DHAKA);
    expect(range.from).toBe(Date.UTC(2026, 8, 15, 18, 0, 0));
    expect(range.to).toBe(TODAY_START);
    expect(range.preset).toBe('custom');
  });

  it('includes the last day somebody picked, because to is exclusive', () => {
    const oneDay = customRange('2026-09-17', '2026-09-17', DHAKA);
    expect(oneDay.to - oneDay.from).toBe(24 * 60 * 60 * 1000);
  });
});

describe('rangeProblem', () => {
  it('passes a range that runs forwards and fits', () => {
    expect(rangeProblem(resolvePreset('30d', NOW, DHAKA))).toBeNull();
  });

  it('names a backwards range rather than answering it with zeroes', () => {
    expect(rangeProblem({ preset: 'custom', from: NOW, to: NOW - 1 })).toBe('backwards');
    expect(rangeProblem({ preset: 'custom', from: NOW, to: NOW })).toBe('backwards');
  });

  // Four hundred days is Chokh's own maximum retention, so past it the question
  // is about rows nothing kept.
  it('names a range longer than anything the store keeps', () => {
    expect(rangeProblem({ preset: 'custom', from: NOW - MAX_RANGE_MS - 1, to: NOW })).toBe(
      'too-long',
    );
    expect(rangeProblem({ preset: 'custom', from: NOW - MAX_RANGE_MS, to: NOW })).toBeNull();
  });
});

describe('defaultInterval', () => {
  const span = (ms: number): DateRange => ({ preset: 'custom', from: NOW - ms, to: NOW });
  const DAY = 24 * 60 * 60 * 1000;

  // The store caps an hourly series at seven days and a minute one at three
  // hours. Nothing here may ever return an interval it would refuse.
  it('never picks an interval the store would refuse', () => {
    expect(defaultInterval(span(DAY))).toBe('hour');
    // Two days, not the seven the store would allow: a week of hours is 168
    // points whose five axis labels are five different hours of five different
    // days, and that reads as noise rather than as a shape.
    expect(defaultInterval(span(2 * DAY))).toBe('hour');
    expect(defaultInterval(span(3 * DAY))).toBe('day');
    expect(defaultInterval(span(7 * DAY))).toBe('day');
    expect(defaultInterval(span(8 * DAY))).toBe('day');
    expect(defaultInterval(span(90 * DAY))).toBe('day');
    expect(defaultInterval(span(91 * DAY))).toBe('week');
    expect(defaultInterval(span(401 * DAY))).toBe('month');
  });

  it('offers minutes only for a window short enough to read them', () => {
    expect(allowedIntervals(span(2 * 60 * 60 * 1000))).toContain('minute');
    expect(allowedIntervals(span(4 * 60 * 60 * 1000))).not.toContain('minute');
    expect(allowedIntervals(span(8 * DAY))).not.toContain('hour');
    expect(allowedIntervals(span(8 * DAY))).toContain('week');
    expect(allowedIntervals(span(DAY))).not.toContain('week');
  });
});

describe('comparisonRange', () => {
  it('puts the previous period immediately before this one', () => {
    const range = resolvePreset('yesterday', NOW, DHAKA);
    const previous = comparisonRange(range, 'previous_period', DHAKA);
    expect(previous.to).toBe(range.from);
    expect(previous.to - previous.from).toBe(range.to - range.from);
  });

  // The same wall clock a year earlier, which is a different number of
  // milliseconds and is the point of asking for it.
  it('puts the previous year on the same clock and not the same offset', () => {
    const range = resolvePreset('today', NOW, DHAKA);
    const previous = comparisonRange(range, 'previous_year', DHAKA);
    expect(new Date(previous.from).getUTCFullYear()).toBe(2025);
    expect(previous.from).toBe(Date.UTC(2025, 8, 17, 18, 0, 0));
  });
});

describe('shiftRange', () => {
  it('walks a window back and forward by its own length', () => {
    const range = resolvePreset('7d', NOW, DHAKA);
    const back = shiftRange(range, -1);
    const length = range.to - range.from;
    expect(back.to).toBe(range.from);
    expect(back.to - back.from).toBe(length);
    expect(shiftRange(back, 1).from).toBe(range.from);
  });

  // A page that still said "Today" over yesterday's numbers would be lying in
  // the one place nobody thinks to check.
  it('stops calling a shifted window by its preset name', () => {
    expect(shiftRange(resolvePreset('today', NOW, DHAKA), -1).preset).toBe('custom');
  });
});

describe('isLive', () => {
  it('knows whether the numbers on screen are still moving', () => {
    expect(isLive(resolvePreset('today', NOW, DHAKA), NOW)).toBe(true);
    expect(isLive(resolvePreset('yesterday', NOW, DHAKA), NOW)).toBe(false);
  });
});
