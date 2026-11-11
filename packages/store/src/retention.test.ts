import { describe, expect, it } from 'vitest';

import {
  activityPlan,
  addVisitorDays,
  attributionValue,
  cohortPlan,
  emptyActivityTally,
  finishAttribution,
  finishCohorts,
  tallyCohorts,
  windowIntervals,
} from './retention.js';
import { ATTRIBUTION_ROW_LIMIT, MAU_DAYS, powerMinDays, type AttributionCount } from './query.js';

const DAY = 24 * 60 * 60 * 1000;

describe('windowIntervals', () => {
  it('merges the days a window ending on any active day covers', () => {
    expect(windowIntervals([0], 1)).toEqual([[0, 0]]);
    expect(windowIntervals([0, 1, 3], 1)).toEqual([
      [0, 1],
      [3, 3],
    ]);
    expect(windowIntervals([0, 3, 20], 7)).toEqual([
      [0, 9],
      [20, 26],
    ]);
    // Days 0 and 7 with a week: [0, 6] and [7, 13] touch, so they are one run.
    expect(windowIntervals([0, 7], 7)).toEqual([[0, 13]]);
  });
});

describe('powerMinDays', () => {
  it('is a third of the window, at least one', () => {
    expect(powerMinDays(30)).toBe(10);
    expect(powerMinDays(90)).toBe(30);
    expect(powerMinDays(7)).toBe(3);
    expect(powerMinDays(1)).toBe(1);
  });
});

describe('cohortPlan', () => {
  it('takes the range back to the start of its week in the zone', () => {
    // Wednesday 2 September 2026, 15:00 in Dhaka.
    const plan = cohortPlan(
      { siteId: 's', from: Date.UTC(2026, 8, 2, 9), to: Date.UTC(2026, 8, 9, 9), interval: 'week' },
      'Asia/Dhaka',
    );
    expect(plan.starts).toEqual([Date.UTC(2026, 7, 30, 18), Date.UTC(2026, 8, 6, 18)]);
    expect(plan.ends).toEqual([Date.UTC(2026, 8, 6, 18), Date.UTC(2026, 8, 13, 18)]);
    expect(plan.span.from).toBe(plan.starts[0]);
  });

  it('refuses more buckets than the cap', () => {
    expect(() =>
      cohortPlan({ siteId: 's', from: 0, to: 30 * 7 * DAY, interval: 'week' }, 'UTC'),
    ).toThrow(/26 weeks/);
  });
});

describe('finishCohorts', () => {
  it('reads every cell, shades the running bucket and stops at now', () => {
    const plan = cohortPlan({ siteId: 's', from: 0, to: 21 * DAY, interval: 'week' }, 'UTC');
    // 1 Jan 1970 was a Thursday, so the plan starts on Monday 29 December 1969.
    const counts = tallyCohorts(
      [
        { visitorId: 'a', startedAt: 0, isNew: true },
        { visitorId: 'a', startedAt: 8 * DAY, isNew: false },
        { visitorId: 'b', startedAt: 9 * DAY, isNew: true },
        // Not first seen here, so in no cohort, and not counted as returning.
        { visitorId: 'c', startedAt: 9 * DAY, isNew: false },
      ],
      plan,
    );
    const result = finishCohorts(plan, counts, 10 * DAY);
    expect(result.cohorts.map((cohort) => cohort.visitors)).toEqual([1, 1, 0, 0]);
    expect(result.cohorts[0]?.periods.map((period) => [period.visitors, period.complete])).toEqual([
      [1, true],
      [1, false],
    ]);
    // A bucket that has not begun yet has no periods.
    expect(result.cohorts[2]?.periods).toEqual([]);
  });
});

describe('activityPlan and addVisitorDays', () => {
  it('reads a month before the range, from the range start of day', () => {
    const plan = activityPlan({ siteId: 's', from: 10 * DAY + 5000, to: 13 * DAY }, 'UTC');
    expect(plan.days).toBe(3);
    expect(plan.offset).toBe(MAU_DAYS - 1);
    expect(plan.range.from).toBe(10 * DAY);
    expect(plan.span.from).toBe(10 * DAY - (MAU_DAYS - 1) * DAY);
    expect(plan.starts).toHaveLength(MAU_DAYS - 1 + 3);
  });

  it('counts each window and the curve from the days of one visitor', () => {
    const plan = activityPlan({ siteId: 's', from: 40 * DAY, to: 43 * DAY }, 'UTC');
    const tally = emptyActivityTally(plan.days);
    // Span day 29 is the range's first day. Active on span days 20, 29 and 31.
    addVisitorDays(tally, plan, { days: [20, 29, 31], first: 20 });
    expect(tally.dau).toEqual([1, 0, 1]);
    expect(tally.wau).toEqual([1, 1, 1]);
    expect(tally.mau).toEqual([1, 1, 1]);
    expect(tally.curve).toEqual([0, 1, 0]);
    expect(tally.returning).toBe(1);
    // Active only before the range: in its month, not in its people.
    addVisitorDays(tally, plan, { days: [5], first: 5 });
    expect(tally.mau).toEqual([2, 2, 2]);
    expect(tally.visitors).toBe(1);
  });

  it('refuses more than ninety days', () => {
    expect(() => activityPlan({ siteId: 's', from: 0, to: 91 * DAY }, 'UTC')).toThrow(/90 days/);
    expect(activityPlan({ siteId: 's', from: 0, to: 90 * DAY }, 'UTC').days).toBe(90);
  });
});

describe('attribution', () => {
  it('reads a dimension off a touch or a stay', () => {
    const source = { channel: 'email', entryPath: '/x', utm: { source: 'news' } };
    expect(attributionValue(source, 'channel')).toBe('email');
    expect(attributionValue(source, 'entry')).toBe('/x');
    expect(attributionValue(source, 'utm_source')).toBe('news');
    expect(attributionValue(source, 'utm_medium')).toBe('');
    expect(attributionValue(undefined, 'referrer')).toBe('');
  });

  it('folds the rows past the limit into other, so each column still adds up', () => {
    const first = new Map<string, AttributionCount>();
    const last = new Map<string, AttributionCount>();
    for (let index = 0; index < ATTRIBUTION_ROW_LIMIT + 5; index += 1) {
      first.set(`k${String(index).padStart(3, '0')}`, { visitors: 1, completions: 2 });
      last.set(`k${String(index).padStart(3, '0')}`, { visitors: 1, completions: 2 });
    }
    const result = finishAttribution('referrer', { kind: 'event', match: 'x', value: 3 }, first, last);
    expect(result.rows).toHaveLength(ATTRIBUTION_ROW_LIMIT);
    expect(result.other.first).toEqual({ visitors: 5, completions: 10 });
    expect(result.visitors).toBe(ATTRIBUTION_ROW_LIMIT + 5);
    expect(result.value).toBe((ATTRIBUTION_ROW_LIMIT + 5) * 2 * 3);
    // Ties are ordered by key, so two reads never reorder.
    expect(result.rows[0]?.key).toBe('k000');
  });
});
