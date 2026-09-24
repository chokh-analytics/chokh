import { z } from 'zod';
import {
  ALERT_WINDOWS,
  MAX_ALERT_CHANNELS,
  type AlertCondition,
  type AlertWindow,
} from '@chokh/store';

// What an alert asks, as a Zod schema, and the arithmetic that answers it.
//
// Everything here is pure: a condition and some numbers in, a decision out.
// The reads that produce the numbers are in evaluate.ts, so the arithmetic can
// be tested on a table of cases without a store, and the store can be swapped
// without touching a threshold.

// The feature name a licence key has to carry, or `*`.
export const ALERTS_FEATURE = 'alerts';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
// The tick, and the bucket every kind but traffic is claimed by.
export const TICK_MS = 5 * 60 * 1000;
// How many weeks back a traffic baseline reaches, and how many of them have to
// be inside retention before the median means anything.
export const BASELINE_WEEKS = 4;
export const BASELINE_MIN_WEEKS = 2;

const window = z.union(
  ALERT_WINDOWS.map((minutes) => z.literal(minutes)) as [
    z.ZodLiteral<AlertWindow>,
    z.ZodLiteral<AlertWindow>,
    ...z.ZodLiteral<AlertWindow>[],
  ],
);

const count = z.number().int().min(1).max(1_000_000);

export const alertConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('traffic'),
      metric: z.enum(['visitors', 'pageviews']),
      direction: z.enum(['up', 'down']),
      // A change smaller than a fifth is weather, and one past tenfold is a
      // number nobody sets on purpose.
      percent: z.number().int().min(20).max(1000),
      minimum: z.number().int().min(1).max(1_000_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goal'),
      goalId: z.string().min(1).max(64),
      direction: z.enum(['above', 'below']),
      count,
      window,
    })
    .strict(),
  z
    .object({
      kind: z.literal('errors'),
      statuses: z.enum(['4xx', '5xx', 'any']),
      count,
      window,
    })
    .strict(),
  z
    .object({
      kind: z.literal('silence'),
      // A tick is five minutes, so nothing shorter can be noticed; a day is as
      // long as "silence" means before it is just a quiet site.
      minutes: z.number().int().min(5).max(1440),
    })
    .strict(),
]);

const address = z.string().trim().email().max(254);

export const alertChannelSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), to: address }).strict(),
  // A chat id is a signed integer as Telegram prints it, or an @channel name.
  z
    .object({
      kind: z.literal('telegram'),
      chatId: z.string().trim().min(1).max(64).regex(/^(-?\d+|@[A-Za-z0-9_]{5,})$/, 'A chat id or an @channel'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('webhook'),
      url: z
        .string()
        .trim()
        .url()
        .max(2048)
        .refine((value) => /^https?:\/\//.test(value), 'A webhook is an http:// or https:// URL'),
      secret: z.string().min(16).max(256).optional(),
    })
    .strict(),
]);

export const createAlertSchema = z
  .object({
    name: z.string().trim().min(1, 'An alert needs a name').max(100),
    condition: alertConditionSchema,
    channels: z.array(alertChannelSchema).min(1, 'An alert needs somewhere to go').max(MAX_ALERT_CHANNELS),
  })
  .strict();

export type CreateAlertInput = z.infer<typeof createAlertSchema>;

export const alertParamsSchema = z.object({
  siteId: z.string().min(1).max(64),
  alertId: z.string().min(1).max(64),
});

// The bucket an alert is claimed by at an instant. Traffic waits for a whole
// hour to complete and is claimed by the hour; everything else watches a
// sliding window and is claimed by the tick.
export function bucketOf(condition: AlertCondition, now: number): number {
  return Math.floor(now / (condition.kind === 'traffic' ? HOUR_MS : TICK_MS));
}

export interface Span {
  from: number;
  to: number;
}

// The last completed hour before `now`, and the same hour on the same weekday
// in each of the previous BASELINE_WEEKS weeks. Whole weeks of hours keep the
// weekday and the clock hour; a zone with daylight saving shifts the clock
// hour by one across the change, which is a baseline one hour off for two
// weeks a year and is accepted rather than solved.
export function trafficSpans(now: number): { current: Span; baselines: Span[] } {
  const end = Math.floor(now / HOUR_MS) * HOUR_MS;
  const current = { from: end - HOUR_MS, to: end };
  const baselines = Array.from({ length: BASELINE_WEEKS }, (_, week) => {
    const back = (week + 1) * 7 * DAY_MS;
    return { from: current.from - back, to: current.to - back };
  });
  return { current, baselines };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (high === undefined) {
    return 0;
  }
  return sorted.length % 2 === 0 && low !== undefined ? (low + high) / 2 : high;
}

export interface Decision {
  firing: boolean;
  value: number;
  baseline: number | null;
}

// Not enough history to say anything, so the check is a no-op and the state
// is left as it was.
export const SKIPPED = Symbol('skipped');

export function decideTraffic(
  condition: Extract<AlertCondition, { kind: 'traffic' }>,
  current: number,
  baselines: readonly number[],
): Decision | typeof SKIPPED {
  // A week that reads nothing is a week the site was not there yet, as far
  // as anybody can tell from the rows, so it is left out rather than pulling
  // the median to zero and calling the second week of a new site a rise.
  const seen = baselines.filter((value) => value > 0);
  if (seen.length < BASELINE_MIN_WEEKS) {
    return SKIPPED;
  }
  const baseline = median(seen);
  // The floor: neither side big enough for a percentage to mean anything.
  if (Math.max(current, baseline) < condition.minimum) {
    return { firing: false, value: current, baseline };
  }
  const factor = condition.percent / 100;
  const firing =
    condition.direction === 'up'
      ? current >= baseline * (1 + factor)
      : current <= baseline * (1 - factor);
  return { firing, value: current, baseline };
}

export function decideCount(direction: 'above' | 'below', count: number, value: number): Decision {
  return {
    firing: direction === 'above' ? value >= count : value < count,
    value,
    baseline: null,
  };
}

// Silence is a window with nothing in it on a site that had something in the
// day before the window: a site nobody has installed yet never alarms.
export function decideSilence(inWindow: number, dayBefore: number): Decision {
  return { firing: inWindow === 0 && dayBefore > 0, value: inWindow, baseline: null };
}

// Whether a status the page declared belongs to the class an alert watches.
export function inStatusClass(statuses: '4xx' | '5xx' | 'any', status: string): boolean {
  if (!/^[1-5]\d\d$/.test(status)) {
    return false;
  }
  if (statuses === 'any') {
    return status >= '400';
  }
  return status.startsWith(statuses[0] ?? '');
}

// The sliding window a goal, an errors or a silence alert reads at `now`.
export function windowSpan(condition: AlertCondition, now: number): Span {
  const minutes =
    condition.kind === 'silence'
      ? condition.minutes
      : condition.kind === 'traffic'
        ? 60
        : condition.window;
  return { from: now - minutes * 60_000, to: now };
}
