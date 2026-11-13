import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportRow } from '../store/AnalyticsStore.js';
import type { SourceFile } from './plausible.js';
import { readText } from './umami.js';

// The fixture exports the importer tests read: small, invented sites written
// from each format's public documentation (Plausible's CSV import page, Umami's
// Prisma schema, Google's RunReportResponse reference), nobody's real export.

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixtureFiles(source: 'plausible' | 'umami' | 'ga4'): SourceFile[] {
  const folder = join(FIXTURES, source);
  return readdirSync(folder)
    .sort()
    .map((name) => ({ name, text: readText(name, readFileSync(join(folder, name))) }));
}

// One row of a parsed import, by day, dimension and key.
export function find(rows: readonly ImportRow[], date: string, dim: string, key = ''): ImportRow | undefined {
  return rows.find((row) => row.date === date && row.dim === dim && row.key === key);
}

export function keys(rows: readonly ImportRow[], date: string, dim: string): string[] {
  return rows
    .filter((row) => row.date === date && row.dim === dim)
    .map((row) => row.key)
    .sort();
}
