import {
  ATTRIBUTION_ROW_LIMIT,
  MAU_DAYS,
  MAX_ACTIVITY_DAYS,
  MAX_COHORTS,
  StoreQueryError,
  WAU_DAYS,
  powerMinDays,
  type ActivityDay,
  type ActivityQuery,
  type ActivityResult,
  type AttributionCount,
  type AttributionDimension,
  type AttributionResult,
  type AttributionRow,
  type Cohort,
  type CohortInterval,
  type CohortQuery,
  type CohortResult,
  type GoalRead,
  type PowerUserRow,
  type Range,
} from './query.js';
import { addDays, bucketEnd, bucketStart, bucketsBetween, dayBounds, dayKey } from './time.js';
import type { Attributes } from './types.js';

// The retention reads' rules (AN-PPL01), in one place so the MongoDB answer and
// the in-memory answer are the same sentence. Each adapter reads its stays its
// own way and hands the tallies here; the windows, the buckets, the cuts and
// the arithmetic are decided once. The definitions are on the result types in
// query.ts.

// What every read here needs of a stay.
export interface StayMark {
  visitorId: string;
  startedAt: number;
  isNew: boolean;
}

// ---------------------------------------------------------------- cohorts

export interface CohortPlan {
  interval: CohortInterval;
  starts: number[];
  ends: number[];
  // The stays to read: from the first cohort's start to the range's end.
  span: Range;
}

export function cohortPlan(query: CohortQuery, timezone: string): CohortPlan {
  if (query.to <= query.from) {
    return { interval: query.interval, starts: [], ends: [], span: { from: query.from, to: query.from } };
  }
  const first = bucketStart(query.from, query.interval, timezone);
  const starts = bucketsBetween(first, query.to, query.interval, timezone);
  const cap = MAX_COHORTS[query.interval];
  if (starts.length > cap) {
    throw new StoreQueryError(
      'RANGE_TOO_LONG',
      `Cohorts read every stay of the range, so they are capped at ${cap} ${query.interval}s`,
    );
  }
  return {
    interval: query.interval,
    starts,
    ends: starts.map((start) => bucketEnd(start, query.interval, timezone)),
    span: { from: first, to: query.to },
  };
}

// cohort index -> bucket index -> visitors.
export type CohortCounts = Map<number, Map<number, number>>;

function bump(counts: CohortCounts, cohort: number, bucket: number, by = 1): void {
  let row = counts.get(cohort);
  if (row === undefined) {
    row = new Map();
    counts.set(cohort, row);
  }
  row.set(bucket, (row.get(bucket) ?? 0) + by);
}

// Add one (cohort, bucket, visitors) cell, for an adapter that already grouped.
export function addCohortCell(
  counts: CohortCounts,
  cohort: number,
  bucket: number,
  visitors: number,
): void {
  if (cohort < 0 || bucket < cohort) return;
  bump(counts, cohort, bucket, visitors);
}

// The bucket a moment falls in, or -1 outside the plan.
export function cohortBucketOf(plan: CohortPlan, ts: number): number {
  if (ts < plan.span.from || ts >= plan.span.to) return -1;
  let low = 0;
  let high = plan.starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (plan.starts[middle]! <= ts) low = middle;
    else high = middle - 1;
  }
  return low;
}

// From the span's stays (crawlers already out) to the grid's counts. A
// visitor's cohort is the bucket of their first stay, the earliest one marked
// new; one whose first stay is before the span is in no cohort here.
export function tallyCohorts(stays: Iterable<StayMark>, plan: CohortPlan): CohortCounts {
  const byVisitor = new Map<string, { cohort: number; buckets: Set<number> }>();
  for (const stay of stays) {
    const bucket = cohortBucketOf(plan, stay.startedAt);
    if (bucket < 0) continue;
    let entry = byVisitor.get(stay.visitorId);
    if (entry === undefined) {
      entry = { cohort: -1, buckets: new Set() };
      byVisitor.set(stay.visitorId, entry);
    }
    entry.buckets.add(bucket);
    if (stay.isNew && (entry.cohort < 0 || bucket < entry.cohort)) entry.cohort = bucket;
  }
  const counts: CohortCounts = new Map();
  for (const entry of byVisitor.values()) {
    if (entry.cohort < 0) continue;
    for (const bucket of entry.buckets) addCohortCell(counts, entry.cohort, bucket, 1);
  }
  return counts;
}

export function finishCohorts(plan: CohortPlan, counts: CohortCounts, now: number): CohortResult {
  const until = Math.min(plan.span.to, now);
  const cohorts = plan.starts.map((start, index): Cohort => {
    const row = counts.get(index);
    const size = row?.get(index) ?? 0;
    const periods = [];
    for (let bucket = index; bucket < plan.starts.length && plan.starts[bucket]! < until; bucket += 1) {
      const visitors = row?.get(bucket) ?? 0;
      periods.push({
        start: plan.starts[bucket]!,
        end: plan.ends[bucket]!,
        visitors,
        rate: size === 0 ? null : visitors / size,
        complete: plan.ends[bucket]! <= until,
      });
    }
    return { start, end: plan.ends[index]!, visitors: size, periods };
  });
  return { interval: plan.interval, cohorts, rawOnly: true };
}

// ---------------------------------------------------------------- activity

// The days a stickiness read covers. The span is the range's days with the
// MAU_DAYS - 1 days before them, so the first day's month is a whole month;
// day i of the span is starts[i], and the range's first day is span day offset.
export interface ActivityPlan {
  starts: number[];
  ends: number[];
  offset: number;
  // How many days the range itself has.
  days: number;
  span: Range;
  // The range, taken back to the start of its first day.
  range: Range;
}

export function activityPlan(query: ActivityQuery, timezone: string): ActivityPlan {
  const firstKey = dayKey(query.from, timezone);
  const rangeFrom = dayBounds(firstKey, timezone).start;
  const keys: string[] = [];
  if (query.to > rangeFrom) {
    const lastKey = dayKey(query.to - 1, timezone);
    for (let key = firstKey; ; key = addDays(key, 1)) {
      keys.push(key);
      if (keys.length > MAX_ACTIVITY_DAYS) {
        throw new StoreQueryError(
          'RANGE_TOO_LONG',
          `Stickiness and power users read every stay of the range, so they are capped at ${MAX_ACTIVITY_DAYS} days`,
        );
      }
      if (key === lastKey) break;
    }
  }
  const offset = MAU_DAYS - 1;
  const before: string[] = [];
  for (let back = offset; back >= 1; back -= 1) before.push(addDays(firstKey, -back));
  const all = [...before, ...keys];
  const bounds = all.map((key) => dayBounds(key, timezone));
  return {
    starts: bounds.map((each) => each.start),
    ends: bounds.map((each) => each.end),
    offset,
    days: keys.length,
    span: { from: bounds[0]!.start, to: Math.max(query.to, rangeFrom) },
    range: { from: rangeFrom, to: Math.max(query.to, rangeFrom) },
  };
}

// The span day a moment falls on, or -1 outside the span.
export function activityDayOf(plan: ActivityPlan, ts: number): number {
  if (ts < plan.span.from || ts >= plan.span.to) return -1;
  let low = 0;
  let high = plan.starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (plan.starts[middle]! <= ts) low = middle;
    else high = middle - 1;
  }
  return low;
}

// One visitor as the fold sees them: the span days they began a stay on, in
// order and without repeats, and the span day of their first stay, or null
// when it is not in the span (they were first seen before it).
export interface VisitorDays {
  days: number[];
  first: number | null;
}

export interface ActivityTally {
  // Per range day.
  dau: number[];
  wau: number[];
  mau: number[];
  // curve[i]: visitors active on exactly i + 1 days of the range.
  curve: number[];
  visitors: number;
  returning: number;
}

export function emptyActivityTally(days: number): ActivityTally {
  const zeros = (): number[] => new Array<number>(days).fill(0);
  return { dau: zeros(), wau: zeros(), mau: zeros(), curve: zeros(), visitors: 0, returning: 0 };
}

export const ACTIVITY_WINDOWS = [1, WAU_DAYS, MAU_DAYS] as const;

// The days a window of w days ending on each active day covers, merged: the
// visitor counts in a window on day x when one of their days is in
// [x - w + 1, x], which is x in [d, d + w - 1] for one of their days d.
export function windowIntervals(days: readonly number[], width: number): [number, number][] {
  const merged: [number, number][] = [];
  for (const day of days) {
    const last = merged[merged.length - 1];
    if (last !== undefined && day <= last[1] + 1) {
      last[1] = Math.max(last[1], day + width - 1);
    } else {
      merged.push([day, day + width - 1]);
    }
  }
  return merged;
}

export function addVisitorDays(tally: ActivityTally, plan: ActivityPlan, visitor: VisitorDays): void {
  const total = plan.starts.length;
  const series = [tally.dau, tally.wau, tally.mau];
  ACTIVITY_WINDOWS.forEach((width, which) => {
    const target = series[which]!;
    for (const [start, end] of windowIntervals(visitor.days, width)) {
      for (let day = Math.max(start, plan.offset); day <= Math.min(end, total - 1); day += 1) {
        target[day - plan.offset]! += 1;
      }
    }
  });
  const active = visitor.days.filter((day) => day >= plan.offset).length;
  if (active === 0) return;
  tally.visitors += 1;
  tally.curve[active - 1]! += 1;
  const latest = visitor.days[visitor.days.length - 1]!;
  if (visitor.first === null || latest > visitor.first) tally.returning += 1;
}

// From stays (crawlers already out) to one VisitorDays per visitor.
export function visitorDaysOf(stays: Iterable<StayMark>, plan: ActivityPlan): VisitorDays[] {
  const byVisitor = new Map<string, { days: Set<number>; first: number | null }>();
  for (const stay of stays) {
    const day = activityDayOf(plan, stay.startedAt);
    if (day < 0) continue;
    let entry = byVisitor.get(stay.visitorId);
    if (entry === undefined) {
      entry = { days: new Set(), first: null };
      byVisitor.set(stay.visitorId, entry);
    }
    entry.days.add(day);
    if (stay.isNew && (entry.first === null || day < entry.first)) entry.first = day;
  }
  return [...byVisitor.values()].map((entry) => ({
    days: [...entry.days].sort((left, right) => left - right),
    first: entry.first,
  }));
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function finishActivity(plan: ActivityPlan, tally: ActivityTally, now: number): ActivityResult {
  const until = Math.min(plan.range.to, now);
  const days: ActivityDay[] = [];
  for (let index = 0; index < plan.days; index += 1) {
    const at = plan.offset + index;
    days.push({
      start: plan.starts[at]!,
      end: plan.ends[at]!,
      dau: tally.dau[index]!,
      wau: tally.wau[index]!,
      mau: tally.mau[index]!,
      complete: plan.ends[at]! <= until,
    });
  }
  const complete = days.filter((day) => day.complete);
  const dau = mean(complete.map((day) => day.dau));
  const wau = mean(complete.map((day) => day.wau));
  const mau = mean(complete.map((day) => day.mau));
  const minDays = powerMinDays(plan.days);
  return {
    days,
    dau,
    wau,
    mau,
    stickiness: dau === null || mau === null || mau === 0 ? null : dau / mau,
    visitors: tally.visitors,
    returning: tally.returning,
    returningRate: tally.visitors === 0 ? null : tally.returning / tally.visitors,
    curve: tally.curve,
    powerMinDays: minDays,
    powerUsers: tally.curve.slice(minDays - 1).reduce((sum, count) => sum + count, 0),
    rawOnly: true,
  };
}

// ---------------------------------------------------------------- power users

// How active one visitor was in a range.
export interface PowerTally {
  visitorId: string;
  activeDays: number;
  visits: number;
}

// Most active days first, then most visits, then the larger visitor id, which
// is the people directory's own tie break.
export function comparePowerUsers(left: PowerTally, right: PowerTally): number {
  if (left.activeDays !== right.activeDays) return right.activeDays - left.activeDays;
  if (left.visits !== right.visits) return right.visits - left.visits;
  if (left.visitorId === right.visitorId) return 0;
  return left.visitorId < right.visitorId ? 1 : -1;
}

export function tallyPowerUsers(stays: Iterable<StayMark>, plan: ActivityPlan): PowerTally[] {
  const byVisitor = new Map<string, { days: Set<number>; visits: number }>();
  for (const stay of stays) {
    if (stay.startedAt < plan.range.from || stay.startedAt >= plan.range.to) continue;
    const day = activityDayOf(plan, stay.startedAt);
    let entry = byVisitor.get(stay.visitorId);
    if (entry === undefined) {
      entry = { days: new Set(), visits: 0 };
      byVisitor.set(stay.visitorId, entry);
    }
    entry.days.add(day);
    entry.visits += 1;
  }
  return [...byVisitor].map(([visitorId, entry]) => ({
    visitorId,
    activeDays: entry.days.size,
    visits: entry.visits,
  }));
}

export function powerUserRow<T extends Omit<PowerUserRow, 'activeDays' | 'visits'>>(
  person: T,
  tally: PowerTally,
): T & { activeDays: number; visits: number } {
  return { ...person, activeDays: tally.activeDays, visits: tally.visits };
}

// ---------------------------------------------------------------- attribution

// What a touch and a stay both carry.
export interface AttributionSource {
  channel?: string;
  referrer?: string;
  utm?: Attributes;
  entryPath?: string;
}

// The value of the dimension on a touch or a stay; '' when there is none.
export function attributionValue(
  source: AttributionSource | undefined,
  dim: AttributionDimension,
): string {
  if (source === undefined) return '';
  if (dim === 'channel') return source.channel ?? '';
  if (dim === 'referrer') return source.referrer ?? '';
  if (dim === 'entry') return source.entryPath ?? '';
  return source.utm?.[dim.slice('utm_'.length)] ?? '';
}

export function zeroAttribution(): AttributionCount {
  return { visitors: 0, completions: 0 };
}

function addCount(into: AttributionCount, from: AttributionCount): void {
  into.visitors += from.visitors;
  into.completions += from.completions;
}

function weight(row: AttributionRow): [number, number] {
  return [
    row.first.visitors + row.last.visitors,
    row.first.completions + row.last.completions,
  ];
}

export function finishAttribution(
  dim: AttributionDimension,
  goal: GoalRead,
  first: Map<string, AttributionCount>,
  last: Map<string, AttributionCount>,
): AttributionResult {
  const keys = new Set([...first.keys(), ...last.keys()]);
  const rows = [...keys].map(
    (key): AttributionRow => ({
      key,
      first: { ...(first.get(key) ?? zeroAttribution()) },
      last: { ...(last.get(key) ?? zeroAttribution()) },
    }),
  );
  rows.sort((left, right) => {
    const [leftVisitors, leftCompletions] = weight(left);
    const [rightVisitors, rightCompletions] = weight(right);
    if (leftVisitors !== rightVisitors) return rightVisitors - leftVisitors;
    if (leftCompletions !== rightCompletions) return rightCompletions - leftCompletions;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  const total = zeroAttribution();
  for (const count of first.values()) addCount(total, count);
  const other = { first: zeroAttribution(), last: zeroAttribution() };
  for (const row of rows.slice(ATTRIBUTION_ROW_LIMIT)) {
    addCount(other.first, row.first);
    addCount(other.last, row.last);
  }
  return {
    dim,
    visitors: total.visitors,
    completions: total.completions,
    value: goal.value === undefined ? null : total.completions * goal.value,
    rows: rows.slice(0, ATTRIBUTION_ROW_LIMIT),
    other,
    rawOnly: true,
  };
}

// One converter, already attributed both ways, into the two columns.
export function attributeConverter(
  first: Map<string, AttributionCount>,
  last: Map<string, AttributionCount>,
  converter: { first: string; last: string; completions: number },
): void {
  for (const [column, key] of [
    [first, converter.first],
    [last, converter.last],
  ] as const) {
    const count = column.get(key) ?? zeroAttribution();
    count.visitors += 1;
    count.completions += converter.completions;
    column.set(key, count);
  }
}
