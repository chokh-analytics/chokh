import type { Totals } from './metrics.js';
import { ROLLUP_TOTAL_DIM, type RollupDim } from './plan.js';
import { BOT_DIMENSION, ROLLED_DIMENSIONS, StoreQueryError } from './query.js';
import { addDays, parseDayKey } from './time.js';

// Imported history: days of another analytics tool's numbers, written as daily
// rollup rows and nothing else.
//
// Never as events. A day of history is what a rollup row already is in every
// store: it outlives the raw retention purge, every report that reads rolled
// days reads it with no read changed, and it puts nobody who never visited into
// People, profiles or funnels. What it cannot answer is anything a rollup cannot
// (an hour, a filter, two dimensions at once, a goal, a funnel), and that is the
// honest answer for numbers somebody else counted.
//
// Each imported row carries the import's id, which is how one import is listed,
// compared, rewritten and taken out again without touching a native row or
// another import. An import may only write a day that cannot hold rows of the
// site's own: rollupDay replaces a day that has raw rows wholesale, and a day
// counted twice, once natively and once imported (or by two imports), would be
// a lie in every total that crosses it.

// 1 to 64 characters: lower-case letters, digits, '.', '_' and '-', starting
// with a letter or a digit. Default: the source's name.
export const IMPORT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// The dimensions an imported row may be filed under: the ones rollupDay writes,
// the day's totals, and the bot series beside them.
export const IMPORT_DIMS: readonly RollupDim[] = [ROLLUP_TOTAL_DIM, BOT_DIMENSION, ...ROLLED_DIMENSIONS];

// The longest key an imported row may carry, a page path being the long one.
export const IMPORT_KEY_LENGTH = 1024;

// One row of an import, for one day of the site's calendar.
export interface ImportRow extends Totals {
  date: string;
  dim: RollupDim;
  key: string;
}

export interface ImportSummary {
  importId: string;
  // The first and last day the import holds, and how many days and rows.
  from: string;
  to: string;
  days: number;
  rows: number;
}

export interface ImportState {
  // The first day of the site's calendar that holds data of its own: a native
  // rollup row or a raw event of any kind. Null for a site with none.
  ownFrom: string | null;
  imports: ImportSummary[];
}

// Why a day of an import was not written.
//
// own_data      the site holds data of its own on or before that day
// recent        the site's today or yesterday, or later: a collector still
//               accepts a row up to 24 hours old, so either can still get raw rows
// other_import  another import holds the day
export type ImportRefusal = 'own_data' | 'recent' | 'other_import';

export interface ImportRefusedDay {
  date: string;
  reason: ImportRefusal;
  // The import that holds the day, when that is the reason.
  heldBy?: string;
}

export interface ImportWriteSummary {
  importId: string;
  // The days written, and the rows they now hold.
  days: number;
  rows: number;
  // In date order.
  refused: ImportRefusedDay[];
}

export interface ImportRemoveSummary {
  importId: string;
  days: number;
  rows: number;
}

// The four methods every store implements for imports. Part of AnalyticsStore.
export interface ImportStore {
  importState(siteId: string): Promise<ImportState>;
  // That import's rows, every day, in no particular order.
  importedRollups(siteId: string, importId: string): Promise<ImportRow[]>;
  // Replace the days the rows cover, for this import only, refusing per day
  // (never failing the call) a day importDecision refuses. A day not in rows is
  // not touched.
  writeImport(siteId: string, importId: string, rows: readonly ImportRow[]): Promise<ImportWriteSummary>;
  removeImport(siteId: string, importId: string): Promise<ImportRemoveSummary>;
}

function invalid(code: string, message: string): never {
  throw new StoreQueryError(code, message);
}

export function checkImportId(importId: unknown): asserts importId is string {
  if (typeof importId !== 'string' || !IMPORT_ID_PATTERN.test(importId)) {
    invalid(
      'INVALID_IMPORT_ID',
      'An import id is 1 to 64 lower-case letters, digits, ".", "_" or "-", starting with a letter or a digit',
    );
  }
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_KEY.test(value)) return false;
  const { year, month, day } = parseDayKey(value);
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const DIMS = new Set<string>(IMPORT_DIMS);

// Every row checked before a store sees any of them, so a bad file writes
// nothing at all: a real calendar day, a dimension a rollup has, a key of
// sensible length, totals that are whole numbers and not negative (duration in
// milliseconds), each key once per day and dimension, and a total row on every
// day, without which the day would read as empty.
export function checkImportRows(rows: readonly ImportRow[]): string[] {
  const seen = new Set<string>();
  const days = new Set<string>();
  const totalled = new Set<string>();
  for (const row of rows) {
    if (!isDayKey(row.date)) invalid('INVALID_IMPORT_ROW', `"${String(row.date)}" is not a day of the calendar`);
    if (!DIMS.has(row.dim)) invalid('INVALID_IMPORT_ROW', `"${String(row.dim)}" is not a dimension a rollup holds`);
    if (typeof row.key !== 'string' || row.key.length > IMPORT_KEY_LENGTH) {
      invalid('INVALID_IMPORT_ROW', `A key on ${row.date} is not a string of at most ${IMPORT_KEY_LENGTH} characters`);
    }
    for (const field of ['visitors', 'pageviews', 'visits', 'bounces', 'durationSum'] as const) {
      if (!isCount(row[field])) {
        invalid('INVALID_IMPORT_ROW', `${field} of ${row.dim} "${row.key}" on ${row.date} is not a whole number of 0 or more`);
      }
    }
    const identity = `${row.date}\n${row.dim}\n${row.key}`;
    if (seen.has(identity)) invalid('INVALID_IMPORT_ROW', `${row.dim} "${row.key}" appears twice on ${row.date}`);
    seen.add(identity);
    days.add(row.date);
    if (row.dim === ROLLUP_TOTAL_DIM) totalled.add(row.date);
  }
  for (const day of days) {
    if (!totalled.has(day)) invalid('INVALID_IMPORT_ROW', `${day} has no total row, so it would read as empty`);
  }
  return [...days].sort();
}

// The rule for one day, in one place, so every store refuses the same days for
// the same reasons. today is the site's own today; holder is the import that
// holds the day now, if any.
export function importDecision(
  importId: string,
  date: string,
  ownFrom: string | null,
  today: string,
  holder: string | undefined,
): ImportRefusedDay | undefined {
  if (date >= addDays(today, -1)) return { date, reason: 'recent' };
  if (ownFrom !== null && date >= ownFrom) return { date, reason: 'own_data' };
  if (holder !== undefined && holder !== importId) return { date, reason: 'other_import', heldBy: holder };
  return undefined;
}

// The summaries of a site's imports from (importId, date) pairs and a row
// count per import, sorted by id.
export function summariseImports(rows: readonly { importId: string; date: string }[]): ImportSummary[] {
  const byId = new Map<string, { days: Set<string>; rows: number }>();
  for (const row of rows) {
    const entry = byId.get(row.importId) ?? { days: new Set<string>(), rows: 0 };
    entry.days.add(row.date);
    entry.rows += 1;
    byId.set(row.importId, entry);
  }
  return [...byId]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([importId, entry]) => {
      const days = [...entry.days].sort();
      return {
        importId,
        from: days[0] as string,
        to: days[days.length - 1] as string,
        days: days.length,
        rows: entry.rows,
      };
    });
}
