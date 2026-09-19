// Every number a person reads passes through here.
//
// This file exists because of two bugs found in this product already, both in
// translation layers and both of which shipped looking right. Chokh's bounce
// rate is a fraction and a percentage is what a page shows, so a missing times
// hundred renders 0% forever, which is a number and not a blank and would not
// be questioned. And a comparison against an empty previous window that answers
// 0 instead of null renders "no change" where the truth is that there is no
// percentage at all. Both rules are one function each, below, with a test each.

const GROUPED = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

// Below this a number is written out in full. "1.3k" for 1,284 rounds away the
// point of a small number to save three glyphs.
export const COMPACT_FROM = 10_000;

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const rounded = Math.round(value);
  if (Math.abs(rounded) < COMPACT_FROM) {
    return GROUPED.format(rounded);
  }
  return COMPACT.format(rounded);
}

// The exact number, for a title attribute and a hover card. A compact label is
// a summary and there is always somewhere to read the whole thing.
export function formatExact(value: number): string {
  return GROUPED.format(Math.round(value));
}

// How a percentage is written, in one place, because three callers below would
// otherwise each pick a rounding.
//
// One decimal under ten, where the difference between 4.2 and 4.8 is the whole
// story, and none above it, where it is noise. A trailing zero is dropped: 8.0%
// is 8%, and the decimal point in it only says that somewhere there was a
// division.
function percentLabel(percent: number): string {
  if (percent >= 10) {
    return `${Math.round(percent)}%`;
  }
  const oneDecimal = percent.toFixed(1);
  return `${oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal}%`;
}

// A fraction from the store becomes a percentage on the page.
export function formatRate(fraction: number | null | undefined): string | null {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
    return null;
  }
  return percentLabel(fraction * 100);
}

// A number that is already a percentage, which is what a scroll depth is.
export function formatPercentPoints(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.round(value)}%`;
}

// A duration in milliseconds, the way somebody says it out loud. Never a
// decimal, and never "192.4 seconds".
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// What a comparison can be. "No baseline" is its own answer and not a zero: a
// previous window with nothing in it did not stay the same, it has no
// percentage, and saying "no change" about it is a wrong number rather than a
// missing one.
export type DeltaKind = 'up' | 'down' | 'flat' | 'none';

export interface Delta {
  kind: DeltaKind;
  // The label, already formatted. Null when the movement has no number: either
  // there is no baseline to compare against, or nothing moved.
  label: string | null;
  // Whether this movement is good, bad, or neither. Not every metric has an
  // opinion, and the ones that do not are drawn in the muted colour.
  tone: 'good' | 'bad' | 'neutral';
}

// Which direction is the good one, per metric. Only bounce rate is inverted,
// and online now has no opinion at all: more people is not better or worse, it
// is just now.
export type GoodWhen = 'up' | 'down' | null;

export const GOOD_WHEN: Record<string, GoodWhen> = {
  visitors: 'up',
  pageviews: 'up',
  visits: 'up',
  viewsPerVisit: 'up',
  bounceRate: 'down',
  avgDuration: 'up',
  onlineNow: null,
};

function toneOf(kind: DeltaKind, goodWhen: GoodWhen): Delta['tone'] {
  if (goodWhen === null || kind === 'flat' || kind === 'none') {
    return 'neutral';
  }
  const rising = kind === 'up';
  return rising === (goodWhen === 'up') ? 'good' : 'bad';
}

// A relative change, as a percentage of the previous value.
export function delta(
  current: number | null | undefined,
  previous: number | null | undefined,
  goodWhen: GoodWhen = null,
): Delta {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return { kind: 'none', label: null, tone: 'neutral' };
  }
  const change = (current - previous) / previous;
  const percent = Math.abs(change) * 100;
  // Under a twentieth of a percent is the same number with rounding on it.
  if (percent < 0.05) {
    return { kind: 'flat', label: null, tone: 'neutral' };
  }
  const kind: DeltaKind = change > 0 ? 'up' : 'down';
  return { kind, label: percentLabel(percent), tone: toneOf(kind, goodWhen) };
}

// A rate moving is measured in points and not in percent. A bounce rate going
// from 38% to 41% is three points; calling it a rise of 7.9% is a true number
// nobody can act on.
export function deltaPoints(
  current: number | null | undefined,
  previous: number | null | undefined,
  goodWhen: GoodWhen = null,
): Delta {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return { kind: 'none', label: null, tone: 'neutral' };
  }
  const points = (current - previous) * 100;
  if (Math.abs(points) < 0.05) {
    return { kind: 'flat', label: null, tone: 'neutral' };
  }
  const kind: DeltaKind = points > 0 ? 'up' : 'down';
  // Points, not percent: the label drops the sign and the per cent mark, and
  // percentLabel is what decides the rounding so a rate and a movement in a
  // rate never round differently.
  const label = `${percentLabel(Math.abs(points)).slice(0, -1)} pts`;
  return { kind, label, tone: toneOf(kind, goodWhen) };
}

// Pageviews over visits. Both come from the API and neither is this number, so
// it is computed in one place with the same guard the rates have.
export function viewsPerVisit(pageviews: number, visits: number): number | null {
  return visits === 0 ? null : pageviews / visits;
}

export function formatRatio(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(1);
}

// Times are always in the site's own zone, never the browser's. A site in Dhaka
// asking what happened today means its own midnight, and a chart labelled in
// the reader's zone is a chart whose buckets do not line up with its own axis.
export function timeFormatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { timeZone, ...options });
}

export function formatClock(ts: number, timeZone: string): string {
  return timeFormatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    ts,
  );
}

export function formatDate(ts: number, timeZone: string): string {
  return timeFormatter(timeZone, { day: 'numeric', month: 'short' }).format(ts);
}

export function formatDateTime(ts: number, timeZone: string): string {
  return `${formatDate(ts, timeZone)}, ${formatClock(ts, timeZone)}`;
}

// How long ago, for anything inside an hour. Past that the clock time is more
// useful than the arithmetic.
export function formatSince(ts: number, now: number, timeZone: string): string {
  const ms = now - ts;
  if (ms < 60_000) {
    return 'now';
  }
  if (ms < 60 * 60_000) {
    return `${Math.floor(ms / 60_000)}m`;
  }
  return formatClock(ts, timeZone);
}

// How long they have been here, which counts from the start of the stay.
export function formatOnlineFor(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// A country code as its flag. Two regional indicator letters, which every
// modern system draws and which costs no image and no request. A code that is
// not two letters comes back empty rather than as two stray glyphs.
export function flagOf(country: string | undefined): string {
  if (country === undefined || !/^[A-Za-z]{2}$/.test(country)) {
    return '';
  }
  return String.fromCodePoint(
    ...[...country.toUpperCase()].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
  );
}
