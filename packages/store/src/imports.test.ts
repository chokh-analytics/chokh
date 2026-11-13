import { describe, expect, it } from 'vitest';

import {
  checkImportId,
  checkImportRows,
  importDecision,
  summariseImports,
  type ImportRow,
} from './imports.js';

function row(date: string, dim: ImportRow['dim'], key = '', visitors = 1): ImportRow {
  return { date, dim, key, visitors, pageviews: 2, visits: 1, bounces: 0, durationSum: 1_000 };
}

describe('checkImportId', () => {
  it('takes a short lower-case name', () => {
    for (const id of ['plausible', 'ga4', 'umami-2025', 'a', 'x.y_z', 'a'.repeat(64)]) {
      expect(() => checkImportId(id)).not.toThrow();
    }
  });

  it('refuses anything else by code', () => {
    for (const id of ['', 'Plausible', '-dash', 'a b', 'a/b', 'a'.repeat(65), 7, null, undefined]) {
      expect(() => checkImportId(id)).toThrow(expect.objectContaining({ code: 'INVALID_IMPORT_ID' }));
    }
  });
});

describe('checkImportRows', () => {
  it('answers the days the rows cover, sorted', () => {
    expect(checkImportRows([row('2025-02-02', 'total'), row('2025-02-01', 'total'), row('2025-02-01', 'page', '/')])).toEqual([
      '2025-02-01',
      '2025-02-02',
    ]);
  });

  const refused: [string, ImportRow[]][] = [
    ['a day that is not on the calendar', [row('2025-02-30', 'total')]],
    ['a date that is not a day key', [row('20250201', 'total')]],
    ['a dimension no rollup holds', [row('2025-02-01', 'total'), row('2025-02-01', 'weather' as ImportRow['dim'])]],
    ['a key longer than 1,024 characters', [row('2025-02-01', 'total'), row('2025-02-01', 'page', 'x'.repeat(1_025))]],
    ['a negative count', [row('2025-02-01', 'total', '', -1)]],
    ['a fraction', [{ ...row('2025-02-01', 'total'), durationSum: 1.5 }]],
    ['a key twice on a day', [row('2025-02-01', 'total'), row('2025-02-01', 'page', '/'), row('2025-02-01', 'page', '/')]],
    ['a day with no total row', [row('2025-02-01', 'page', '/')]],
  ];
  for (const [what, rows] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => checkImportRows(rows)).toThrow(expect.objectContaining({ code: 'INVALID_IMPORT_ROW' }));
    });
  }
});

describe('importDecision', () => {
  const today = '2026-09-18';

  it('lets through a day before the site has data of its own, and before yesterday', () => {
    expect(importDecision('p', '2026-09-10', '2026-09-16', today, undefined)).toBeUndefined();
    expect(importDecision('p', '2026-09-16', null, today, undefined)).toBeUndefined();
    expect(importDecision('p', '2026-09-10', '2026-09-16', today, 'p')).toBeUndefined();
  });

  it('refuses today, yesterday and later as recent, whatever else is true', () => {
    for (const date of ['2026-09-17', '2026-09-18', '2026-09-19', '2030-01-01']) {
      expect(importDecision('p', date, null, today, undefined)).toEqual({ date, reason: 'recent' });
    }
  });

  it('refuses the day the site has its own data from, and every day after it', () => {
    expect(importDecision('p', '2026-09-16', '2026-09-16', today, undefined)).toEqual({ date: '2026-09-16', reason: 'own_data' });
    expect(importDecision('p', '2026-09-15', '2026-09-15', today, undefined)?.reason).toBe('own_data');
  });

  it("refuses another import's day and names it", () => {
    expect(importDecision('p', '2026-09-10', null, today, 'umami')).toEqual({
      date: '2026-09-10',
      reason: 'other_import',
      heldBy: 'umami',
    });
  });
});

describe('summariseImports', () => {
  it('counts days and rows per import, with the first and last day', () => {
    expect(
      summariseImports([
        { importId: 'umami', date: '2025-01-03' },
        { importId: 'ga4', date: '2025-01-02' },
        { importId: 'ga4', date: '2025-01-01' },
        { importId: 'ga4', date: '2025-01-01' },
      ]),
    ).toEqual([
      { importId: 'ga4', from: '2025-01-01', to: '2025-01-02', days: 2, rows: 3 },
      { importId: 'umami', from: '2025-01-03', to: '2025-01-03', days: 1, rows: 1 },
    ]);
  });
});
