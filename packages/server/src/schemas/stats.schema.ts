import { z } from 'zod';

import {
  DIMENSIONS,
  type Dimension,
  type Filter,
  type Metrics,
  type Query,
} from '../store/AnalyticsStore.js';

// The query string of every report route, validated once.
//
// The shape is the store's own query, on purpose: from, to, filters, compare,
// interval, dim, limit. Nothing here translates between an API vocabulary and an
// internal one, because there is only one vocabulary and a site owner reading the
// README is reading the same words the pipelines group by.

// An instant, given the way whoever is calling finds it easiest: epoch
// milliseconds from a program, an ISO 8601 date or timestamp from a person or a
// URL somebody typed. A bare date means midnight UTC, which is why a dashboard
// asking about a site in Dhaka sends instants and not dates.
const instant = z
  .string()
  .min(1)
  .transform((value, context) => {
    if (/^\d+$/.test(value)) {
      return Number(value);
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected epoch milliseconds or an ISO 8601 date',
      });
      return z.NEVER;
    }
    return parsed;
  });

const dimension = z.enum(DIMENSIONS as [Dimension, ...Dimension[]]);

const OPERATORS: Readonly<Record<string, Filter['op']>> = {
  '==': 'is',
  '!=': 'is_not',
  '~': 'contains',
};

const filterObject = z.object({
  dim: dimension,
  op: z.enum(['is', 'is_not', 'contains']),
  value: z.string(),
});

// Two spellings, because both callers are real. A dashboard builds filters as
// objects and sends them as JSON; a person testing a route with curl writes
// page==/pricing;browser!=Firefox;city~Dhaka. The compact form has no escape, so
// a value containing a semicolon has to go as JSON, and the README says so.
function parseCompactFilters(
  raw: string,
): { ok: true; filters: unknown[] } | { ok: false; message: string } {
  const filters: unknown[] = [];
  for (const clause of raw.split(';')) {
    const text = clause.trim();
    if (text === '') {
      continue;
    }
    const operator = Object.keys(OPERATORS).find((candidate) => text.includes(candidate));
    if (operator === undefined) {
      return { ok: false, message: `${text} needs one of ==, != or ~` };
    }
    const at = text.indexOf(operator);
    filters.push({
      dim: text.slice(0, at).trim(),
      op: OPERATORS[operator],
      value: text.slice(at + operator.length).trim(),
    });
  }
  return { ok: true, filters };
}

const filters = z
  .string()
  .transform((value, context): Filter[] => {
    const trimmed = value.trim();
    if (trimmed === '') {
      return [];
    }
    let raw: unknown[];
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
          throw new Error('not an array');
        }
        raw = parsed;
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'filters is not valid JSON' });
        return z.NEVER;
      }
    } else {
      const compact = parseCompactFilters(trimmed);
      if (!compact.ok) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: compact.message });
        return z.NEVER;
      }
      raw = compact.filters;
    }
    const checked = z.array(filterObject).safeParse(raw);
    if (!checked.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `filters: ${checked.error.issues.map((issue) => issue.message).join(', ')}`,
      });
      return z.NEVER;
    }
    return checked.data;
  });

// The names the artifact's route list uses, which are not all the field names the
// store answers with: a person asks for duration and bounce_rate, the store calls
// them avgDurationMs and bounceRate.
export const METRIC_NAMES = [
  'visitors',
  'pageviews',
  'visits',
  'bounces',
  'bounce_rate',
  'duration',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

const METRIC_KEYS: Readonly<Record<MetricName, keyof Metrics>> = {
  visitors: 'visitors',
  pageviews: 'pageviews',
  visits: 'visits',
  bounces: 'bounces',
  bounce_rate: 'bounceRate',
  duration: 'avgDurationMs',
};

const metrics = z
  .string()
  .transform((value, context): MetricName[] => {
    const names = value
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    const unknown = names.filter((name) => !(METRIC_NAMES as readonly string[]).includes(name));
    if (unknown.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown metric ${unknown.join(', ')}. Known: ${METRIC_NAMES.join(', ')}`,
      });
      return z.NEVER;
    }
    return names as MetricName[];
  });

// Narrow a metrics object to what the caller asked for. Nothing asked means all
// of them: they cost the same to compute, so this is about a smaller response and
// never about a cheaper query.
export function projectMetrics(all: Metrics, names: MetricName[] | undefined): Partial<Metrics> {
  if (names === undefined || names.length === 0) {
    return all;
  }
  const picked: Partial<Metrics> = {};
  for (const name of names) {
    const key = METRIC_KEYS[name];
    // One assignment per key rather than a computed index, so the types stay
    // honest about which field is a number and which can be null.
    if (key === 'bounceRate' || key === 'avgDurationMs') {
      picked[key] = all[key];
    } else {
      picked[key] = all[key];
    }
  }
  return picked;
}

export const statsQuerySchema = z.object({
  from: instant,
  to: instant,
  filters: filters.optional(),
  compare: z.enum(['previous_period', 'previous_year']).optional(),
  interval: z.enum(['hour', 'day', 'week', 'month']).optional(),
  dim: dimension.optional(),
  metrics: metrics.optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

export type StatsQueryInput = z.infer<typeof statsQuerySchema>;

// The store's query, built from the request and the site the route already
// resolved. A range with to at or before from is refused here rather than
// answered with an empty report, because an empty report reads as "nobody came".
export function toStoreQuery(siteId: string, input: StatsQueryInput): Query {
  const query: Query = { siteId, from: input.from, to: input.to };
  if (input.filters !== undefined && input.filters.length > 0) query.filters = input.filters;
  if (input.compare !== undefined) query.compare = input.compare;
  if (input.interval !== undefined) query.interval = input.interval;
  if (input.dim !== undefined) query.dim = input.dim;
  if (input.limit !== undefined) query.limit = input.limit;
  return query;
}

export const RANGE_BACKWARDS = 'to has to be after from';
