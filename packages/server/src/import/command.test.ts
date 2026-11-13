import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';
import { dayBounds, defaultSiteSettings, type Site } from '../store/AnalyticsStore.js';
import { runImportCommand } from './command.js';
import { FIXTURES } from './fixtures.test-utils.js';

// The command end to end, on a real store (the memory one, which passes the
// same conformance cases as MongoDB and PostgreSQL), reading the fixture files
// from disk. The clock is a constant, so no case depends on when it runs.

const NOW = Date.UTC(2026, 0, 15, 6, 0, 0);
const TIMEZONE = 'Asia/Dhaka';

function site(id: string): Site {
  return {
    id,
    name: id,
    domains: [`${id}.example`],
    teamId: 't_import',
    settings: defaultSiteSettings({ timezone: TIMEZONE }),
  };
}

let store: MemoryStore;
let output: string[];
const scratch = mkdtempSync(join(tmpdir(), 'chokh-import-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  store = createMemoryStore([], { now: () => NOW });
  await store.createSite(site('s_import'));
  output = [];
});

function run(...argv: string[]): Promise<number> {
  return runImportCommand(argv, { store, print: (line) => output.push(line), now: () => NOW });
}

async function visitorsOn(day: string, siteId = 's_import'): Promise<number> {
  const bounds = dayBounds(day, TIMEZONE);
  return (await store.aggregate({ siteId, from: bounds.start, to: bounds.end })).metrics.visitors;
}

const plausible = join(FIXTURES, 'plausible');

describe('chokh-import', () => {
  it('prints what it would write and writes nothing without --apply', async () => {
    expect(await run('plausible', '--site', 's_import', plausible)).toBe(0);
    expect(output).toContain('    new       2 days, 42 rows');
    expect(output).toContain('Dry run: nothing was written. Run again with --apply to write the new and changed days.');
    expect(output.some((line) => line.includes('imported_visitors_20250101_20250102.csv: 2 rows (visitors)'))).toBe(true);
    expect((await store.importState('s_import')).imports).toEqual([]);
    expect(await visitorsOn('2025-01-01')).toBe(0);
  });

  it('writes with --apply, and a second run of the same files writes nothing', async () => {
    await run('plausible', '--site', 's_import', '--apply', plausible);
    expect(output).toContain('Wrote 2 days, 42 rows, as import "plausible".');
    expect(await visitorsOn('2025-01-01')).toBe(10);
    expect(await visitorsOn('2025-01-02')).toBe(8);
    const before = await store.importedRollups('s_import', 'plausible');

    output = [];
    await run('plausible', '--site', 's_import', '--apply', plausible);
    expect(output).toContain('    unchanged 2 days, 42 rows');
    expect(output).toContain('Nothing to write: every day is already imported as it is in these files.');
    expect(await store.importedRollups('s_import', 'plausible')).toEqual(before);
  });

  it('writes only the day a changed file changed', async () => {
    await run('plausible', '--site', 's_import', '--apply', plausible);
    const changed = join(scratch, 'changed');
    cpSync(plausible, changed, { recursive: true });
    const totals = join(changed, 'imported_visitors_20250101_20250102.csv');
    writeFileSync(totals, readFileSync(totals, 'utf8').replace('"2025-01-02",8,20', '"2025-01-02",9,20'));

    output = [];
    await run('plausible', '--site', 's_import', '--apply', changed);
    expect(output).toContain('    changed   1 day, 15 rows');
    expect(output).toContain('    unchanged 1 day, 27 rows');
    expect(output).toContain('Wrote 1 day, 15 rows, as import "plausible".');
    expect(await visitorsOn('2025-01-02')).toBe(9);
  });

  it('refuses the days another import holds, and the days the site has data of its own', async () => {
    await run('plausible', '--site', 's_import', '--apply', plausible);
    output = [];
    await run('umami', '--site', 's_import', join(FIXTURES, 'umami'));
    expect(output).toContain('    refused   2 days');
    expect(output).toContain('      2025-01-01 held by import "plausible"');

    await store.createSite(site('s_live'));
    await store.ingest([
      { siteId: 's_live', ts: dayBounds('2025-01-02', TIMEZONE).start + 60_000, receivedAt: NOW, type: 'pageview', visitorId: 'v1', path: '/', bot: false },
    ]);
    output = [];
    await run('ga4', '--site', 's_live', '--apply', join(FIXTURES, 'ga4'));
    expect(output).toContain('  the site has data of its own from 2025-01-02');
    expect(output).toContain('      2025-01-02 the site has data of its own');
    expect(output).toContain('Wrote 1 day, 12 rows, as import "ga4".');
    expect(output.some((line) => line.includes('left out: a pagePath row of "(not set)" (1 row)'))).toBe(true);
  });

  it('lists the imports, and takes one back out only with --apply', async () => {
    await run('plausible', '--site', 's_import', '--id', 'plausible-2025', '--apply', plausible);
    output = [];
    await run('--list', '--site', 's_import');
    expect(output).toEqual([
      'Site s_import: data of its own from no day yet.',
      '  plausible-2025: 2025-01-01 to 2025-01-02, 2 days, 42 rows',
    ]);

    output = [];
    await run('--remove', 'plausible-2025', '--site', 's_import');
    expect(output[0]).toBe('Would remove import "plausible-2025" from s_import: 2 days, 42 rows.');
    expect(await visitorsOn('2025-01-01')).toBe(10);

    output = [];
    await run('--remove', 'plausible-2025', '--site', 's_import', '--apply');
    expect(output).toEqual(['Removed import "plausible-2025" from s_import: 2 days, 42 rows.']);
    expect(await visitorsOn('2025-01-01')).toBe(0);
    expect((await store.importState('s_import')).imports).toEqual([]);
  });

  it('refuses what it cannot do, saying why', async () => {
    await expect(run('plausible', plausible)).rejects.toThrow('--site is required');
    await expect(run('plausible', '--site', 'nobody', plausible)).rejects.toThrow('no site answers to nobody');
    await expect(run('--site', 's_import', plausible)).rejects.toThrow('name a source');
    await expect(run('plausible', '--site', 's_import', '--id', 'Not An Id', plausible)).rejects.toMatchObject({ code: 'INVALID_IMPORT_ID' });
    await expect(run('plausible', '--site', 's_import', '--sight', 'x', plausible)).rejects.toThrow('unknown option --sight');
    await expect(run('ga4', '--site', 's_import', plausible)).rejects.toThrow('no ga4 files');
  });
});
