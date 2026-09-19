import { DIMENSIONS, SESSION_DIMENSIONS, type Dimension, type Filter } from '@chokh/store/contract';

// Filters, in the spelling the store already parses.
//
// A filter goes on the wire as page==/pricing;browser!=Firefox;city~Dhaka,
// which is the compact form the stats schema reads, because a URL somebody can
// read and hand edit is worth more than JSON in a query string. The compact
// form has no escape, so a value carrying a semicolon goes as JSON instead, and
// which one is used is decided here rather than at a call site.

export type Operator = Filter['op'];

export const OPERATOR_SIGNS: Record<Operator, string> = {
  is: '==',
  is_not: '!=',
  contains: '~',
};

// Longest first, so a value containing = does not match the wrong sign.
const SIGNS: [string, Operator][] = [
  ['==', 'is'],
  ['!=', 'is_not'],
  ['~', 'contains'],
];

export function isDimension(value: string): value is Dimension {
  return (DIMENSIONS as readonly string[]).includes(value);
}

// The three a raw event does not carry. The store refuses a filter naming one
// with UNSUPPORTED_FILTER rather than answering an empty report, so the
// dashboard refuses it a step earlier: a row that cannot filter is not
// clickable, and a filter that cannot be applied is never built.
export function isFilterable(dim: Dimension): boolean {
  return !SESSION_DIMENSIONS.includes(dim);
}

export function filterKey(filter: Filter): string {
  return `${filter.dim}${OPERATOR_SIGNS[filter.op]}${filter.value}`;
}

// A value that would break the compact spelling. Semicolons separate clauses
// and the signs separate a dimension from its value, so a value holding either
// has to travel as JSON.
function needsJson(filters: Filter[]): boolean {
  return filters.some(
    (filter) =>
      filter.value.includes(';') ||
      filter.value.includes('==') ||
      filter.value.includes('!=') ||
      filter.value.includes('~'),
  );
}

export function encodeFilters(filters: Filter[]): string {
  if (filters.length === 0) {
    return '';
  }
  if (needsJson(filters)) {
    return JSON.stringify(filters);
  }
  return filters.map(filterKey).join(';');
}

function parseCompact(text: string): Filter[] {
  const filters: Filter[] = [];
  for (const clause of text.split(';')) {
    const trimmed = clause.trim();
    if (trimmed === '') {
      continue;
    }
    // == before ~, because != contains neither and == contains no ~; checking
    // in this order is what stops a value with a tilde in it splitting early.
    const found = SIGNS.map(([sign, op]) => ({ sign, op, at: trimmed.indexOf(sign) })).filter(
      (candidate) => candidate.at !== -1,
    );
    if (found.length === 0) {
      continue;
    }
    const first = found.reduce((best, candidate) => (candidate.at < best.at ? candidate : best));
    const dim = trimmed.slice(0, first.at).trim();
    const value = trimmed.slice(first.at + first.sign.length).trim();
    if (!isDimension(dim) || value === '') {
      continue;
    }
    filters.push({ dim, op: first.op, value });
  }
  return filters;
}

function parseJson(text: string): Filter[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((candidate): candidate is Filter => {
      if (typeof candidate !== 'object' || candidate === null) {
        return false;
      }
      const row = candidate as Record<string, unknown>;
      return (
        typeof row.dim === 'string' &&
        isDimension(row.dim) &&
        (row.op === 'is' || row.op === 'is_not' || row.op === 'contains') &&
        typeof row.value === 'string'
      );
    });
  } catch {
    return [];
  }
}

// A URL is something anybody can type, so anything unreadable in it is dropped
// rather than thrown: a malformed clause loses that clause and leaves the rest
// of the view standing. The alternative is a page that refuses to load because
// somebody mistyped a link.
export function decodeFilters(text: string | null | undefined): Filter[] {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') {
    return [];
  }
  const filters = trimmed.startsWith('[') ? parseJson(trimmed) : parseCompact(trimmed);
  // The store would refuse these, so they never reach it.
  return dedupe(filters.filter((filter) => isFilterable(filter.dim)));
}

// The same dimension and operator twice is a person clicking the same row
// twice. Keeping both would send a query that can never match anything, which
// looks like a site with no traffic.
export function dedupe(filters: Filter[]): Filter[] {
  const seen = new Set<string>();
  const kept: Filter[] = [];
  for (const filter of filters) {
    const key = filterKey(filter);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(filter);
  }
  return kept;
}

// Clicking a row adds its value. Clicking the same row again takes it off,
// because the second click is somebody undoing the first.
export function toggleFilter(filters: Filter[], filter: Filter): Filter[] {
  if (!isFilterable(filter.dim)) {
    return filters;
  }
  const key = filterKey(filter);
  if (filters.some((existing) => filterKey(existing) === key)) {
    return filters.filter((existing) => filterKey(existing) !== key);
  }
  // One dimension at a time: two values of the same dimension with "is" can
  // never both be true, so the new one replaces the old rather than producing
  // an empty report.
  const others =
    filter.op === 'is'
      ? filters.filter((existing) => !(existing.dim === filter.dim && existing.op === 'is'))
      : filters;
  return [...others, filter];
}

export function removeFilter(filters: Filter[], filter: Filter): Filter[] {
  const key = filterKey(filter);
  return filters.filter((existing) => filterKey(existing) !== key);
}
