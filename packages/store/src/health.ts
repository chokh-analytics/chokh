import { StoreQueryError } from './query.js';

// The health reads (AN-VIT01): Core Web Vitals per page, JavaScript errors
// grouped by message, and how much of a site's signed-in traffic the tracker
// never sees. Each adapter reads its raw rows its own way and hands the tallies
// here; the buckets, the percentile, the thresholds, the order and the cuts are
// decided once, so the MongoDB answer and the in-memory answer are the same
// sentence. Raw rows only: no rollup holds a vital or an error (a percentile
// does not add up across days), so these see as far back as the site keeps its
// events, and each is capped at about 90 days.

export const MAX_HEALTH_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// A 90 day window drawn on a site's calendar can be an hour longer across a
// clock change, so the cap has that hour of slack.
const MAX_HEALTH_MS = MAX_HEALTH_DAYS * DAY_MS + 60 * 60 * 1000;

export function assertHealthRange(from: number, to: number): void {
  if (to - from > MAX_HEALTH_MS) {
    throw new StoreQueryError(
      'RANGE_TOO_LONG',
      `Vitals, errors and coverage read raw rows, so they are capped at ${MAX_HEALTH_DAYS} days`,
    );
  }
}

// ---------------------------------------------------------------- vitals

// What v.js reports. LCP, INP and CLS are the Core Web Vitals; FCP and TTFB
// are the two that explain them.
export const VITAL_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];

export function isVitalMetric(value: string): value is VitalMetric {
  return (VITAL_METRICS as readonly string[]).includes(value);
}

export type VitalRating = 'good' | 'needs-improvement' | 'poor';

// A figure drawn from fewer samples than this is "too few", never a number.
export const VITAL_MIN_SAMPLES = 20;
export const VITAL_PAGE_LIMIT = 50;

// A value is kept as a bucket: milliseconds rounded up to 10 ms, CLS rounded up
// to 0.01, so a bucket is never better than what was measured and a p75 sits on
// a value somebody could read off a chart. The thresholds are the published
// Core Web Vitals ones, written in buckets so a rating is integer arithmetic
// and never a float compared with a float.
interface VitalScale {
  // The largest believable value; anything above it, or below zero, is noise.
  max: number;
  // Bucket boundaries, inclusive: good at or below good, poor above poor.
  good: number;
  poor: number;
}

export const VITAL_SCALES: Readonly<Record<VitalMetric, VitalScale>> = {
  LCP: { max: 600_000, good: 250, poor: 400 },
  INP: { max: 600_000, good: 20, poor: 50 },
  CLS: { max: 100, good: 10, poor: 25 },
  FCP: { max: 600_000, good: 180, poor: 300 },
  TTFB: { max: 600_000, good: 80, poor: 180 },
};

// The bucket of one measurement, or null for a value nobody could have
// measured. Both adapters compute exactly this (the MongoDB pipeline writes the
// same two operations), because the sum and the product are the same IEEE
// doubles in both places.
export function vitalBucket(metric: VitalMetric, value: number): number | null {
  const scale = VITAL_SCALES[metric];
  if (!Number.isFinite(value) || value < 0 || value > scale.max) {
    return null;
  }
  if (metric === 'CLS') {
    return Math.ceil(Math.floor(value * 1000 + 0.5) / 10);
  }
  return Math.ceil(Math.floor(value + 0.5) / 10);
}

// What a bucket reads as: milliseconds, or the unitless CLS.
export function vitalBucketValue(metric: VitalMetric, bucket: number): number {
  return metric === 'CLS' ? bucket / 100 : bucket * 10;
}

export function rateVitalBucket(metric: VitalMetric, bucket: number): VitalRating {
  const scale = VITAL_SCALES[metric];
  if (bucket <= scale.good) return 'good';
  if (bucket <= scale.poor) return 'needs-improvement';
  return 'poor';
}

export interface VitalBucketCount {
  q: number;
  n: number;
}

// What an adapter answers: one histogram per page, device and metric.
export interface VitalCell {
  page: string;
  device: string;
  metric: VitalMetric;
  buckets: VitalBucketCount[];
}

export interface VitalFigure {
  // The 75th percentile by nearest rank over the buckets, in milliseconds (CLS
  // unitless); null when fewer than minSamples measurements are behind it.
  p75: number | null;
  samples: number;
  rating: VitalRating | null;
}

export interface VitalShares {
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface VitalDeviceFigure extends VitalFigure {
  device: string;
}

export interface VitalSummary extends VitalFigure {
  metric: VitalMetric;
  // Fractions of the samples in each band; null when the p75 is.
  shares: VitalShares | null;
  devices: VitalDeviceFigure[];
}

export interface VitalPage {
  page: string;
  // The samples of the metric the pages are sorted by.
  samples: number;
  metrics: Partial<Record<VitalMetric, VitalFigure>>;
}

export interface VitalsQuery {
  siteId: string;
  from: number;
  to: number;
  // One device class only (desktop, mobile, tablet), when asked.
  device?: string;
  // Which metric orders the slow pages; LCP when absent.
  sort?: VitalMetric;
}

export interface VitalsResult {
  minSamples: number;
  sort: VitalMetric;
  metrics: VitalSummary[];
  // The slow pages: slowest p75 of the sort metric first, the pages with too
  // few samples of it after the rest, at most VITAL_PAGE_LIMIT.
  pages: VitalPage[];
  pagesTotal: number;
  rawOnly: true;
}

function addBuckets(into: Map<number, number>, buckets: readonly VitalBucketCount[]): void {
  for (const bucket of buckets) {
    into.set(bucket.q, (into.get(bucket.q) ?? 0) + bucket.n);
  }
}

// The nearest rank p75 of a histogram, and its sample count.
export function vitalFigure(metric: VitalMetric, histogram: ReadonlyMap<number, number>): VitalFigure {
  const sorted = [...histogram.entries()].sort((left, right) => left[0] - right[0]);
  const samples = sorted.reduce((sum, [, n]) => sum + n, 0);
  if (samples < VITAL_MIN_SAMPLES) {
    return { p75: null, samples, rating: null };
  }
  const rank = Math.ceil(0.75 * samples);
  let seen = 0;
  let bucket = sorted[sorted.length - 1]![0];
  for (const [q, n] of sorted) {
    seen += n;
    if (seen >= rank) {
      bucket = q;
      break;
    }
  }
  return {
    p75: vitalBucketValue(metric, bucket),
    samples,
    rating: rateVitalBucket(metric, bucket),
  };
}

function shares(metric: VitalMetric, histogram: ReadonlyMap<number, number>, samples: number): VitalShares {
  const counts = { good: 0, 'needs-improvement': 0, poor: 0 };
  for (const [q, n] of histogram) {
    counts[rateVitalBucket(metric, q)] += n;
  }
  return {
    good: counts.good / samples,
    needsImprovement: counts['needs-improvement'] / samples,
    poor: counts.poor / samples,
  };
}

const DEVICE_ORDER = ['desktop', 'mobile', 'tablet'];

function compareDevices(left: string, right: string): number {
  const a = DEVICE_ORDER.indexOf(left);
  const b = DEVICE_ORDER.indexOf(right);
  if (a !== b) return (a === -1 ? DEVICE_ORDER.length : a) - (b === -1 ? DEVICE_ORDER.length : b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function foldVitals(cells: readonly VitalCell[], sort: VitalMetric = 'LCP'): VitalsResult {
  const site = new Map<VitalMetric, Map<number, number>>();
  const byDevice = new Map<VitalMetric, Map<string, Map<number, number>>>();
  const byPage = new Map<string, Map<VitalMetric, Map<number, number>>>();
  for (const cell of cells) {
    const all = site.get(cell.metric) ?? new Map<number, number>();
    site.set(cell.metric, all);
    addBuckets(all, cell.buckets);

    const devices = byDevice.get(cell.metric) ?? new Map<string, Map<number, number>>();
    byDevice.set(cell.metric, devices);
    const device = devices.get(cell.device) ?? new Map<number, number>();
    devices.set(cell.device, device);
    addBuckets(device, cell.buckets);

    const page = byPage.get(cell.page) ?? new Map<VitalMetric, Map<number, number>>();
    byPage.set(cell.page, page);
    const metric = page.get(cell.metric) ?? new Map<number, number>();
    page.set(cell.metric, metric);
    addBuckets(metric, cell.buckets);
  }

  const metrics: VitalSummary[] = VITAL_METRICS.map((metric) => {
    const histogram = site.get(metric) ?? new Map<number, number>();
    const figure = vitalFigure(metric, histogram);
    const devices = [...(byDevice.get(metric) ?? new Map<string, Map<number, number>>()).entries()]
      .sort((left, right) => compareDevices(left[0], right[0]))
      .map(([device, counts]): VitalDeviceFigure => ({ device, ...vitalFigure(metric, counts) }));
    return {
      metric,
      ...figure,
      shares: figure.p75 === null ? null : shares(metric, histogram, figure.samples),
      devices,
    };
  });

  const pages: VitalPage[] = [...byPage.entries()].map(([page, perMetric]) => {
    const figures: Partial<Record<VitalMetric, VitalFigure>> = {};
    for (const metric of VITAL_METRICS) {
      const histogram = perMetric.get(metric);
      if (histogram !== undefined) figures[metric] = vitalFigure(metric, histogram);
    }
    return { page, samples: figures[sort]?.samples ?? 0, metrics: figures };
  });
  pages.sort((left, right) => {
    const a = left.metrics[sort]?.p75 ?? null;
    const b = right.metrics[sort]?.p75 ?? null;
    if (a !== null && b !== null && a !== b) return b - a;
    if (a === null && b !== null) return 1;
    if (a !== null && b === null) return -1;
    if (left.samples !== right.samples) return right.samples - left.samples;
    return left.page < right.page ? -1 : left.page > right.page ? 1 : 0;
  });

  return {
    minSamples: VITAL_MIN_SAMPLES,
    sort,
    metrics,
    pages: pages.slice(0, VITAL_PAGE_LIMIT),
    pagesTotal: pages.length,
    rawOnly: true,
  };
}

// ---------------------------------------------------------------- errors

export const ERROR_GROUP_DEFAULT_LIMIT = 50;
export const ERROR_GROUP_MAX_LIMIT = 100;
// How many pages and browsers a group lists.
export const ERROR_FACET_LIMIT = 3;

export interface ErrorsQuery {
  siteId: string;
  from: number;
  to: number;
  limit?: number;
}

// The newest row of a group, as stored (already scrubbed by the collector).
export interface ErrorSample {
  at: number;
  page: string;
  browser: string;
  frame?: string;
  stack?: string;
}

// What an adapter answers per message.
export interface ErrorMessageTally {
  message: string;
  count: number;
  visitors: number;
  firstSeen: number;
  lastSeen: number;
  sample: ErrorSample;
}

// And per message and page, or message and browser.
export interface ErrorFacetTally {
  message: string;
  key: string;
  count: number;
}

export interface ErrorTallies {
  // Every error row of the range, and the distinct visitors behind them.
  total: number;
  visitors: number;
  // How many distinct messages the range has. The messages below may be only
  // the biggest of them (an adapter can cut them in the database, in the order
  // foldErrors sorts by), and the pages and browsers need only cover those.
  groupsTotal: number;
  messages: ErrorMessageTally[];
  pages: ErrorFacetTally[];
  browsers: ErrorFacetTally[];
}

export interface ErrorGroup {
  message: string;
  count: number;
  visitors: number;
  firstSeen: number;
  lastSeen: number;
  pages: Array<{ page: string; count: number }>;
  browsers: Array<{ browser: string; count: number }>;
  sample: ErrorSample;
}

export interface ErrorsResult {
  total: number;
  visitors: number;
  // Biggest first: most rows, then the newest, then the message.
  groups: ErrorGroup[];
  groupsTotal: number;
  rawOnly: true;
}

function topFacets(rows: readonly ErrorFacetTally[]): Map<string, ErrorFacetTally[]> {
  const byMessage = new Map<string, ErrorFacetTally[]>();
  for (const row of rows) {
    const list = byMessage.get(row.message) ?? [];
    list.push(row);
    byMessage.set(row.message, list);
  }
  for (const [message, list] of byMessage) {
    list.sort((left, right) =>
      left.count !== right.count ? right.count - left.count : left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
    byMessage.set(message, list.slice(0, ERROR_FACET_LIMIT));
  }
  return byMessage;
}

export function foldErrors(tallies: ErrorTallies, limit: number = ERROR_GROUP_DEFAULT_LIMIT): ErrorsResult {
  const pages = topFacets(tallies.pages);
  const browsers = topFacets(tallies.browsers);
  const sorted = [...tallies.messages].sort((left, right) => {
    if (left.count !== right.count) return right.count - left.count;
    if (left.lastSeen !== right.lastSeen) return right.lastSeen - left.lastSeen;
    return left.message < right.message ? -1 : left.message > right.message ? 1 : 0;
  });
  const groups = sorted.slice(0, limit).map(
    (row): ErrorGroup => ({
      message: row.message,
      count: row.count,
      visitors: row.visitors,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      pages: (pages.get(row.message) ?? []).map((each) => ({ page: each.key, count: each.count })),
      browsers: (browsers.get(row.message) ?? []).map((each) => ({
        browser: each.key,
        count: each.count,
      })),
      sample: row.sample,
    }),
  );
  return {
    total: tallies.total,
    visitors: tallies.visitors,
    groups,
    groupsTotal: tallies.groupsTotal,
    rawOnly: true,
  };
}

// ---------------------------------------------------------------- coverage

// How much of a site's signed-in traffic the tracker never sees. Chokh has no
// server pageviews, and must not (a server event is never a pageview), so the
// estimate is per person: of the people the site's own server named in the
// range, the share no browser row of the range carries. That is blocked or
// declined (a content blocker, Do Not Track, consent not given), and it is
// only an estimate of the signed-in part of the traffic.
export const COVERAGE_MIN_PEOPLE = 20;

export type CoverageState = 'ok' | 'no_server_events' | 'no_browser_identity' | 'too_few';

export interface CoverageQuery {
  siteId: string;
  from: number;
  to: number;
}

// What an adapter answers: one row per userId with an identified row in the
// range, saying where it was seen.
export interface CoverageTally {
  userId: string;
  server: boolean;
  browser: boolean;
}

export interface CoverageResult {
  state: CoverageState;
  // The people the site's server named in the range.
  people: number;
  // How many of those a browser row of the range also carries, and how many not.
  seenInBrowser: number;
  serverOnly: number;
  // serverOnly over people, a fraction; null unless the state is ok.
  share: number | null;
  // Everybody identified in a browser in the range, server or not.
  browserIdentified: number;
  minPeople: number;
  rawOnly: true;
}

export function foldCoverage(tallies: readonly CoverageTally[]): CoverageResult {
  let people = 0;
  let seenInBrowser = 0;
  let browserIdentified = 0;
  for (const row of tallies) {
    if (row.browser) browserIdentified += 1;
    if (!row.server) continue;
    people += 1;
    if (row.browser) seenInBrowser += 1;
  }
  const serverOnly = people - seenInBrowser;
  // Where every person would read as blocked for a reason that is not a
  // blocker, the report says so rather than printing 100%.
  const state: CoverageState =
    people === 0
      ? 'no_server_events'
      : browserIdentified === 0
        ? 'no_browser_identity'
        : people < COVERAGE_MIN_PEOPLE
          ? 'too_few'
          : 'ok';
  return {
    state,
    people,
    seenInBrowser,
    serverOnly,
    share: state === 'ok' ? serverOnly / people : null,
    browserIdentified,
    minPeople: COVERAGE_MIN_PEOPLE,
    rawOnly: true,
  };
}
