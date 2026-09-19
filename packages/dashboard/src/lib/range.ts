import { addDays, dayBounds, dayKey, shiftYears, type Interval } from '@chokh/store/time';

// What a date range is, and how a preset becomes two instants.
//
// Every boundary here is drawn in the site's own timezone and never in the
// browser's. A site in Dhaka asking "how many came today" means its own
// midnight; a from that is six hours out gives a truncated leading bucket,
// which on the chart is a dip on the left edge that reads as a real drop in
// traffic. That is the backend's most expensive finding on this product, and
// this is the file where the dashboard does not repeat it.
//
// The arithmetic itself is @chokh/store/time, the same functions the store
// groups its rollup keys with, so a day in a browser and a day in a pipeline
// are the same instant by construction rather than by agreement.

export const PRESETS = ['today', 'yesterday', '7d', '30d', 'custom'] as const;

export type Preset = (typeof PRESETS)[number];

export interface DateRange {
  preset: Preset;
  // Epoch milliseconds. from is inclusive, to is exclusive, the way every store
  // query is.
  from: number;
  to: number;
}

export type Compare = 'previous_period' | 'previous_year';

export function isPreset(value: unknown): value is Preset {
  return typeof value === 'string' && (PRESETS as readonly string[]).includes(value);
}

// How many whole days back a preset reaches. Today is the day itself, so zero.
const DAYS_BACK: Record<Exclude<Preset, 'custom'>, number> = {
  today: 0,
  yesterday: 1,
  '7d': 6,
  '30d': 29,
};

// A preset, resolved against a clock and a zone.
//
// Today and the two multi day windows run to now rather than to the end of the
// day, because a chart that draws twelve empty hours ahead of the current one
// looks like traffic that stopped. Yesterday is the exception and runs to this
// morning's midnight: it is the one window whose number stops moving once it is
// drawn, which is the whole reason somebody picks it.
export function resolvePreset(preset: Preset, now: number, timezone: string): DateRange {
  if (preset === 'custom') {
    // A custom range is two instants a person chose, so there is nothing to
    // resolve. The caller keeps its own from and to; this is the fallback for a
    // URL that says custom and carries neither.
    return resolvePreset('7d', now, timezone);
  }
  const todayKey = dayKey(now, timezone);
  const startKey = addDays(todayKey, -DAYS_BACK[preset]);
  const from = dayBounds(startKey, timezone).start;
  if (preset === 'yesterday') {
    return { preset, from, to: dayBounds(todayKey, timezone).start };
  }
  return { preset, from, to: now };
}

// A custom range from two dates a person picked, snapped outward to whole days
// of the site's calendar. Outward, so a day either end is never half read: half
// a day of traffic in the first bucket is the same lie as a truncated hour.
export function customRange(fromDate: string, toDate: string, timezone: string): DateRange {
  const from = dayBounds(fromDate, timezone).start;
  // The picker's end date is the last day somebody wants, and to is exclusive,
  // so it is the end of that day and not its start.
  const to = dayBounds(toDate, timezone).end;
  return { preset: 'custom', from, to };
}

// The longest window the store will answer. Chokh's own maximum retention, so
// asking for more is asking about rows nothing kept.
export const MAX_RANGE_DAYS = 400;
export const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

export type RangeProblem = 'backwards' | 'too-long' | null;

export function rangeProblem(range: DateRange): RangeProblem {
  if (range.to <= range.from) {
    return 'backwards';
  }
  if (range.to - range.from > MAX_RANGE_MS) {
    return 'too-long';
  }
  return null;
}

// Which bucket size a range gets when nobody has chosen one.
//
// The store caps an hourly series at 7 days and a minute one at 3 hours,
// because neither has a rollup behind it. This never returns an interval the
// store would refuse, so a range change can never produce a failed request that
// a person has to understand.
export function defaultInterval(range: DateRange): Interval {
  const days = (range.to - range.from) / (24 * 60 * 60 * 1000);
  if (days <= 7) {
    return 'hour';
  }
  if (days <= 90) {
    return 'day';
  }
  if (days <= MAX_RANGE_DAYS) {
    return 'week';
  }
  return 'month';
}

// Which intervals a range may be drawn at, for the picker. An interval the
// store would refuse is not offered rather than offered and then explained.
export function allowedIntervals(range: DateRange): Interval[] {
  const span = range.to - range.from;
  const hours = span / (60 * 60 * 1000);
  const days = hours / 24;
  const allowed: Interval[] = [];
  if (hours <= 3) {
    allowed.push('minute');
  }
  if (days <= 7) {
    allowed.push('hour');
  }
  allowed.push('day');
  if (days > 7) {
    allowed.push('week');
  }
  if (days > 60) {
    allowed.push('month');
  }
  return allowed;
}

// Where a comparison reads from. The same two rules the store has, because the
// dashboard has to label the previous window and the store only returns its
// numbers. previous_period is the range again, ending where this one starts;
// previous_year is the same wall clock a year earlier, which is a different
// number of milliseconds and is the point.
export function comparisonRange(range: DateRange, compare: Compare, timezone: string): DateRange {
  if (compare === 'previous_period') {
    const length = range.to - range.from;
    return { preset: 'custom', from: range.from - length, to: range.from };
  }
  return {
    preset: 'custom',
    from: shiftYears(range.from, -1, timezone),
    to: shiftYears(range.to, -1, timezone),
  };
}

// The same window, one length earlier or later. This is what the bracket keys
// do, and it is how somebody walks week over week without opening a calendar.
//
// A preset keeps its name only when it still describes the window: stepping
// back from "today" lands on a day that is not today, so it becomes a custom
// range, and a page that still said "Today" over yesterday's numbers would be
// lying in the one place a person is not looking.
export function shiftRange(range: DateRange, direction: -1 | 1): DateRange {
  const length = range.to - range.from;
  return {
    preset: 'custom',
    from: range.from + direction * length,
    to: range.to + direction * length,
  };
}

// Whether a range runs up to the present, which is what decides whether the
// numbers on screen are still moving and therefore whether to keep asking.
export function isLive(range: DateRange, now: number): boolean {
  return range.to >= now;
}
