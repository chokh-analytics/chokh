import { describe, expect, it } from 'vitest';

import {
  BASELINE_WEEKS,
  DAY_MS,
  HOUR_MS,
  SKIPPED,
  TICK_MS,
  alertChannelSchema,
  alertConditionSchema,
  bucketOf,
  createAlertSchema,
  decideCount,
  decideSilence,
  decideTraffic,
  inStatusClass,
  median,
  trafficSpans,
  windowSpan,
} from './conditions.js';

// The arithmetic, on a table. What a store would read is a number here, so
// every threshold is proved without a row in sight.

const DROP = { kind: 'traffic', metric: 'visitors', direction: 'down', percent: 50, minimum: 20 } as const;
const RISE = { kind: 'traffic', metric: 'pageviews', direction: 'up', percent: 100, minimum: 20 } as const;

// A decision, or the test fails: the skip has cases of its own.
function traffic(condition: typeof DROP | typeof RISE, current: number, baselines: number[]) {
  const decision = decideTraffic(condition, current, baselines);
  if (decision === SKIPPED) {
    throw new Error('skipped');
  }
  return decision;
}

describe('the traffic decision', () => {
  it('fires a drop at the threshold and not a hair above it', () => {
    expect(traffic(DROP, 50, [100, 100, 100, 100])).toEqual({ firing: true, value: 50, baseline: 100 });
    expect(traffic(DROP, 51, [100, 100, 100, 100])).toEqual({ firing: false, value: 51, baseline: 100 });
    expect(traffic(DROP, 0, [100, 100, 100, 100]).firing).toBe(true);
  });

  it('fires a rise at the threshold, against the median and not the mean', () => {
    // One freak week does not move the baseline: the median of 100, 100, 100
    // and 1000 is 100.
    expect(traffic(RISE, 200, [100, 1000, 100, 100])).toEqual({ firing: true, value: 200, baseline: 100 });
    expect(traffic(RISE, 199, [100, 1000, 100, 100]).firing).toBe(false);
  });

  it('holds its tongue under the floor', () => {
    // Three visitors at 3 am becoming nine is "up 200%" and nothing anybody
    // wants a message about.
    expect(traffic(RISE, 9, [3, 3, 3, 3])).toEqual({ firing: false, value: 9, baseline: 3 });
    // Either side reaching the floor is enough: 0 against a usual 40 is a drop.
    expect(traffic(DROP, 0, [40, 40, 40, 40]).firing).toBe(true);
    // A rise from nothing is a site that was not there: no baseline, skipped.
    expect(decideTraffic(RISE, 20, [0, 0, 0, 0])).toBe(SKIPPED);
  });

  it('skips when fewer than two weeks are there to compare against', () => {
    expect(decideTraffic(DROP, 10, [100])).toBe(SKIPPED);
    expect(decideTraffic(DROP, 10, [])).toBe(SKIPPED);
    // A week reading nothing is a week the site was not there: not a week.
    expect(decideTraffic(DROP, 10, [100, 0, 0, 0])).toBe(SKIPPED);
    expect(decideTraffic(DROP, 10, [100, 100, 0, 0])).toEqual({ firing: true, value: 10, baseline: 100 });
  });
});

describe('median', () => {
  it('takes the middle, or the mean of the two middles', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBe(0);
  });
});

describe('the count decisions', () => {
  it('reads above as at least, and below as fewer than', () => {
    expect(decideCount('above', 10, 10).firing).toBe(true);
    expect(decideCount('above', 10, 9).firing).toBe(false);
    expect(decideCount('below', 1, 0).firing).toBe(true);
    expect(decideCount('below', 1, 1).firing).toBe(false);
    expect(decideCount('above', 10, 12)).toEqual({ firing: true, value: 12, baseline: null });
  });

  it('calls silence only on a site that had something the day before', () => {
    expect(decideSilence(0, 412).firing).toBe(true);
    expect(decideSilence(0, 0).firing).toBe(false);
    expect(decideSilence(3, 412)).toEqual({ firing: false, value: 3, baseline: null });
  });
});

describe('the status classes', () => {
  it('reads a class by its first digit and "any" as 400 and up', () => {
    expect(inStatusClass('5xx', '500')).toBe(true);
    expect(inStatusClass('5xx', '503')).toBe(true);
    expect(inStatusClass('5xx', '404')).toBe(false);
    expect(inStatusClass('4xx', '404')).toBe(true);
    expect(inStatusClass('any', '404')).toBe(true);
    expect(inStatusClass('any', '500')).toBe(true);
    expect(inStatusClass('any', '200')).toBe(false);
    expect(inStatusClass('any', '399')).toBe(false);
    // A key that is not three digits is a rollup of nothing.
    expect(inStatusClass('any', 'abc')).toBe(false);
  });
});

describe('the spans and the buckets', () => {
  // 2026-09-24 10:17 UTC, a Thursday.
  const NOW = Date.UTC(2026, 8, 24, 10, 17, 0);

  it('reads the last completed hour and the same hour four Thursdays back', () => {
    const { current, baselines } = trafficSpans(NOW);
    expect(current).toEqual({ from: Date.UTC(2026, 8, 24, 9), to: Date.UTC(2026, 8, 24, 10) });
    expect(baselines).toHaveLength(BASELINE_WEEKS);
    expect(baselines[0]).toEqual({ from: Date.UTC(2026, 8, 17, 9), to: Date.UTC(2026, 8, 17, 10) });
    expect(baselines[3]).toEqual({ from: Date.UTC(2026, 7, 27, 9), to: Date.UTC(2026, 7, 27, 10) });
    for (const span of baselines) {
      expect(new Date(span.from).getUTCDay()).toBe(4);
      expect(span.to - span.from).toBe(HOUR_MS);
    }
  });

  it('claims traffic by the hour and everything else by the tick', () => {
    expect(bucketOf(DROP, NOW)).toBe(Math.floor(NOW / HOUR_MS));
    expect(bucketOf(DROP, NOW + 42 * 60_000)).toBe(bucketOf(DROP, NOW));
    expect(bucketOf(DROP, NOW + HOUR_MS)).toBe(bucketOf(DROP, NOW) + 1);
    const silence = { kind: 'silence', minutes: 30 } as const;
    expect(bucketOf(silence, NOW)).toBe(Math.floor(NOW / TICK_MS));
    expect(bucketOf(silence, NOW + TICK_MS)).toBe(bucketOf(silence, NOW) + 1);
  });

  it('slides the window back from now', () => {
    expect(windowSpan({ kind: 'silence', minutes: 30 }, NOW)).toEqual({ from: NOW - 30 * 60_000, to: NOW });
    expect(windowSpan({ kind: 'errors', statuses: '5xx', count: 5, window: 1440 }, NOW)).toEqual({
      from: NOW - DAY_MS,
      to: NOW,
    });
  });
});

describe('the schemas', () => {
  it('takes each kind and refuses a number outside its range', () => {
    expect(alertConditionSchema.safeParse(DROP).success).toBe(true);
    expect(alertConditionSchema.safeParse({ ...DROP, percent: 19 }).success).toBe(false);
    expect(alertConditionSchema.safeParse({ ...DROP, percent: 1001 }).success).toBe(false);
    expect(alertConditionSchema.safeParse({ kind: 'goal', goalId: 'g_1', direction: 'below', count: 1, window: 1440 }).success).toBe(true);
    expect(alertConditionSchema.safeParse({ kind: 'goal', goalId: 'g_1', direction: 'below', count: 1, window: 30 }).success).toBe(false);
    expect(alertConditionSchema.safeParse({ kind: 'errors', statuses: '5xx', count: 5, window: 15 }).success).toBe(true);
    expect(alertConditionSchema.safeParse({ kind: 'silence', minutes: 5 }).success).toBe(true);
    expect(alertConditionSchema.safeParse({ kind: 'silence', minutes: 4 }).success).toBe(false);
    expect(alertConditionSchema.safeParse({ kind: 'silence', minutes: 30, extra: 1 }).success).toBe(false);
    expect(alertConditionSchema.safeParse({ kind: 'replay' }).success).toBe(false);
  });

  it('takes an address, a chat id or an @channel, and an http(s) webhook', () => {
    expect(alertChannelSchema.safeParse({ kind: 'email', to: 'ops@example.test' }).success).toBe(true);
    expect(alertChannelSchema.safeParse({ kind: 'email', to: 'not an address' }).success).toBe(false);
    expect(alertChannelSchema.safeParse({ kind: 'telegram', chatId: '-1001234567890' }).success).toBe(true);
    expect(alertChannelSchema.safeParse({ kind: 'telegram', chatId: '@progsity_ops' }).success).toBe(true);
    expect(alertChannelSchema.safeParse({ kind: 'telegram', chatId: 'ops' }).success).toBe(false);
    expect(alertChannelSchema.safeParse({ kind: 'webhook', url: 'https://example.test/hook' }).success).toBe(true);
    expect(alertChannelSchema.safeParse({ kind: 'webhook', url: 'ftp://example.test/hook' }).success).toBe(false);
    expect(alertChannelSchema.safeParse({ kind: 'webhook', url: 'https://example.test/hook', secret: 'short' }).success).toBe(false);
  });

  it('asks for a name, a condition and one to five channels', () => {
    const channel = { kind: 'webhook', url: 'https://example.test/hook' };
    expect(createAlertSchema.safeParse({ name: 'Drop', condition: DROP, channels: [channel] }).success).toBe(true);
    expect(createAlertSchema.safeParse({ name: ' ', condition: DROP, channels: [channel] }).success).toBe(false);
    expect(createAlertSchema.safeParse({ name: 'Drop', condition: DROP, channels: [] }).success).toBe(false);
    expect(
      createAlertSchema.safeParse({ name: 'Drop', condition: DROP, channels: Array(6).fill(channel) }).success,
    ).toBe(false);
  });
});
