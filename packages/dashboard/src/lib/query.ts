import type { Dimension, Filter } from '@chokh/store/contract';
import type { Interval } from '@chokh/store/time';

import { decodeFilters, encodeFilters } from './filters.js';
import {
  allowedIntervals,
  customRange,
  defaultInterval,
  isPreset,
  rangeProblem,
  resolvePreset,
  type Compare,
  type DateRange,
  type Preset,
} from './range.js';

// What a person is looking at, and the URL that reproduces it.
//
// Every view in this dashboard is a link. The site is in the path, and the
// range, the comparison, the filters and the chart metric are in the query
// string, so a link pasted into a chat window opens exactly what the sender was
// reading. That is worth more than it sounds: half of what an analytics
// dashboard is for is one person showing another person a number.
//
// A parameter that makes no sense is dropped rather than thrown. A URL is
// something anybody can edit, and a page that refuses to load because a
// character is wrong is worse than one that loads without a filter.

export const METRICS = [
  'visitors',
  'pageviews',
  'visits',
  'bounceRate',
  'avgDuration',
] as const;

export type MetricName = (typeof METRICS)[number];

export function isMetric(value: unknown): value is MetricName {
  return typeof value === 'string' && (METRICS as readonly string[]).includes(value);
}

export interface ViewQuery {
  range: DateRange;
  compare: Compare | null;
  filters: Filter[];
  // Null means "whatever the range calls for", which is what almost every view
  // wants. A person who picked one keeps it until the range stops allowing it.
  interval: Interval | null;
  // Which metric the overview chart draws. It is in the URL because it is part
  // of what somebody is showing somebody else.
  metric: MetricName;
}

// The parameter names, in one place, because they are a contract with every
// link anybody has ever sent.
export const PARAM = {
  range: 'range',
  from: 'from',
  to: 'to',
  compare: 'compare',
  filters: 'filters',
  interval: 'interval',
  metric: 'metric',
} as const;

export const DEFAULT_PRESET: Preset = '7d';
export const DEFAULT_METRIC: MetricName = 'visitors';

// Comparison is on by default for a preset window.
//
// A number without a comparison is a number nobody can act on, which is the
// second of the five rules this dashboard is designed around. Plausible puts
// this behind a menu and most people never find it.
export const DEFAULT_COMPARE: Compare = 'previous_period';

function readCompare(value: string | null): Compare | null {
  if (value === 'previous_period' || value === 'previous_year') {
    return value;
  }
  // An explicit "off" is a person turning it off, and has to survive a reload
  // as firmly as turning it on does.
  if (value === 'off' || value === 'none') {
    return null;
  }
  return DEFAULT_COMPARE;
}

function readInterval(value: string | null, range: DateRange): Interval | null {
  if (value === null) {
    return null;
  }
  const allowed = allowedIntervals(range);
  return (allowed as string[]).includes(value) ? (value as Interval) : null;
}

// A custom range needs both ends. Half of one is a link somebody truncated, and
// falling back to the default window is better than showing a day that starts
// at the epoch.
function readRange(params: URLSearchParams, now: number, timezone: string): DateRange {
  const preset = params.get(PARAM.range);
  const from = params.get(PARAM.from);
  const to = params.get(PARAM.to);

  if (preset === 'custom' || (from !== null && to !== null)) {
    const range = readInstants(from, to, timezone);
    if (range !== null && rangeProblem(range) === null) {
      return range;
    }
  }
  return resolvePreset(isPreset(preset) ? preset : DEFAULT_PRESET, now, timezone);
}

// Two spellings, because both callers are real: a dashboard writes epoch
// milliseconds, and a person editing a link writes 2026-09-18.
function readInstants(from: string | null, to: string | null, timezone: string): DateRange | null {
  if (from === null || to === null) {
    return null;
  }
  if (/^\d+$/.test(from) && /^\d+$/.test(to)) {
    return { preset: 'custom', from: Number(from), to: Number(to) };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return customRange(from, to, timezone);
  }
  return null;
}

export function parseQuery(
  search: string | URLSearchParams,
  now: number,
  timezone: string,
): ViewQuery {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const range = readRange(params, now, timezone);
  const metric = params.get(PARAM.metric);
  return {
    range,
    compare: readCompare(params.get(PARAM.compare)),
    filters: decodeFilters(params.get(PARAM.filters)),
    interval: readInterval(params.get(PARAM.interval), range),
    metric: isMetric(metric) ? metric : DEFAULT_METRIC,
  };
}

// The shortest URL that reproduces this view. Anything at its default is left
// out, so the common case is a short link and the parameters that are there are
// the ones somebody chose.
export function toSearchParams(query: ViewQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.range.preset === 'custom') {
    params.set(PARAM.range, 'custom');
    params.set(PARAM.from, String(query.range.from));
    params.set(PARAM.to, String(query.range.to));
  } else if (query.range.preset !== DEFAULT_PRESET) {
    params.set(PARAM.range, query.range.preset);
  }

  if (query.compare === null) {
    params.set(PARAM.compare, 'off');
  } else if (query.compare !== DEFAULT_COMPARE) {
    params.set(PARAM.compare, query.compare);
  }

  const filters = encodeFilters(query.filters);
  if (filters !== '') {
    params.set(PARAM.filters, filters);
  }

  if (query.interval !== null) {
    params.set(PARAM.interval, query.interval);
  }

  if (query.metric !== DEFAULT_METRIC) {
    params.set(PARAM.metric, query.metric);
  }

  return params;
}

export function toSearch(query: ViewQuery): string {
  const text = toSearchParams(query).toString();
  return text === '' ? '' : `?${text}`;
}

// What actually gets sent, once the derived parts are settled. This is the
// shape every request in the dashboard is built from, so two reports of the
// same view can never disagree about the window they are asking about.
export interface StatsParams {
  from: number;
  to: number;
  filters?: string;
  compare?: Compare;
  interval?: Interval;
  dim?: Dimension;
  limit?: number;
}

export function toStatsParams(
  query: ViewQuery,
  extra: { dim?: Dimension; limit?: number; interval?: Interval } = {},
): StatsParams {
  const params: StatsParams = { from: query.range.from, to: query.range.to };
  const filters = encodeFilters(query.filters);
  if (filters !== '') {
    params.filters = filters;
  }
  if (query.compare !== null) {
    params.compare = query.compare;
  }
  const interval = extra.interval ?? query.interval ?? defaultInterval(query.range);
  params.interval = interval;
  if (extra.dim !== undefined) {
    params.dim = extra.dim;
  }
  if (extra.limit !== undefined) {
    params.limit = extra.limit;
  }
  return params;
}

// The key a cached answer is filed under. Built from the resolved window rather
// than from the URL, so the two spellings of the same days share one read
// instead of each paying for its own: that is the lesson the backend learned
// the same way.
export function cacheKey(siteId: string, params: StatsParams): unknown[] {
  return [
    siteId,
    params.from,
    params.to,
    params.filters ?? '',
    params.compare ?? '',
    params.interval ?? '',
    params.dim ?? '',
    params.limit ?? 0,
  ];
}
