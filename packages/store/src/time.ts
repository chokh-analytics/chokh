// Every day boundary in Chokh is drawn in the site's own timezone: the rollup
// date keys, the split between today's raw rows and the rolled up history, and
// the buckets of a time series. One helper decides all of them, so an adapter
// can never disagree with the suite about where a day ends.

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached !== undefined) {
    return cached;
  }
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`);
  }
  formatters.set(timezone, made);
  return made;
}

export function wallClock(ts: number, timezone: string): WallClock {
  const parts = formatter(timezone).formatToParts(new Date(ts));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

// How far the zone is from UTC at that instant, offsets and all.
function offsetMs(ts: number, timezone: string): number {
  const wall = wallClock(ts, timezone);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asIfUtc - Math.floor(ts / 1000) * 1000;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

// The instant a calendar date begins in the zone. Two passes, because the
// offset that turns midnight into an instant is itself read at an instant, and
// a zone that shifts overnight answers differently on either side of it.
function instantOfMidnight(year: number, month: number, day: number, timezone: string): number {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = naive - offsetMs(naive, timezone);
  return naive - offsetMs(first, timezone);
}

// The date key a moment belongs to, YYYY-MM-DD in the site's timezone. This is
// the key rollups_daily is written under, which is why it cannot change later.
export function dayKey(ts: number, timezone: string): string {
  const wall = wallClock(ts, timezone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

export function parseDayKey(key: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) {
    throw new Error(`A day key is YYYY-MM-DD, not: ${key}`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// [start, end) of a date key, as instants.
export function dayBounds(key: string, timezone: string): { start: number; end: number } {
  const { year, month, day } = parseDayKey(key);
  const start = instantOfMidnight(year, month, day, timezone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const end = instantOfMidnight(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timezone,
  );
  return { start, end };
}

export function startOfDay(ts: number, timezone: string): number {
  return dayBounds(dayKey(ts, timezone), timezone).start;
}

export function addDays(key: string, days: number): string {
  const { year, month, day } = parseDayKey(key);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

// Every date key touched by [from, to).
export function dayKeysBetween(from: number, to: number, timezone: string): string[] {
  if (to <= from) {
    return [];
  }
  const keys: string[] = [];
  let key = dayKey(from, timezone);
  const last = dayKey(to - 1, timezone);
  for (;;) {
    keys.push(key);
    if (key === last || keys.length > 4000) {
      break;
    }
    key = addDays(key, 1);
  }
  return keys;
}

export type Interval = 'hour' | 'day' | 'week' | 'month';

// The instant the bucket holding ts begins. Weeks start on Monday, which is
// what a Bangladeshi working week and ISO-8601 agree on.
export function bucketStart(ts: number, interval: Interval, timezone: string): number {
  const wall = wallClock(ts, timezone);
  if (interval === 'hour') {
    // Shift into the zone, cut to the hour there, shift back. Zones offset by
    // 45 minutes are as correct as zones offset by a whole hour this way.
    const offset = offsetMs(ts, timezone);
    return Math.floor((ts + offset) / 3_600_000) * 3_600_000 - offset;
  }
  if (interval === 'month') {
    return instantOfMidnight(wall.year, wall.month, 1, timezone);
  }
  if (interval === 'week') {
    const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
    const backToMonday = (weekday + 6) % 7;
    const monday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day - backToMonday));
    return instantOfMidnight(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
      timezone,
    );
  }
  return instantOfMidnight(wall.year, wall.month, wall.day, timezone);
}

// The start of every bucket the range covers, in order.
export function bucketsBetween(
  from: number,
  to: number,
  interval: Interval,
  timezone: string,
): number[] {
  if (to <= from) {
    return [];
  }
  const starts: number[] = [];
  let at = bucketStart(from, interval, timezone);
  while (at < to && starts.length <= 10_000) {
    starts.push(at);
    at = nextBucket(at, interval, timezone);
  }
  return starts;
}

function nextBucket(start: number, interval: Interval, timezone: string): number {
  if (interval === 'hour') {
    return start + 3_600_000;
  }
  const wall = wallClock(start, timezone);
  if (interval === 'month') {
    return instantOfMidnight(wall.year, wall.month + 1, 1, timezone);
  }
  const step = interval === 'week' ? 7 : 1;
  const moved = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + step));
  return instantOfMidnight(
    moved.getUTCFullYear(),
    moved.getUTCMonth() + 1,
    moved.getUTCDate(),
    timezone,
  );
}

// The same wall clock a whole number of years earlier or later, resolved back
// to an instant in the zone. This is what "the same period last year" means to
// a person, and February 29th lands on March 1st the way Date.UTC settles it.
export function shiftYears(ts: number, years: number, timezone: string): number {
  const wall = wallClock(ts, timezone);
  const shifted = new Date(
    Date.UTC(wall.year + years, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second),
  );
  const midnight = instantOfMidnight(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    timezone,
  );
  return midnight + (wall.hour * 3600 + wall.minute * 60 + wall.second) * 1000;
}
