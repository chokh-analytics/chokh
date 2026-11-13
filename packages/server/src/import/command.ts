import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { checkImportId, checkImportRows, type AnalyticsStore, type ImportRow } from '../store/AnalyticsStore.js';
import { parseGa4 } from './ga4.js';
import { planImport, type DayPlan } from './plan.js';
import { parsePlausible, type ParsedImport, type SourceFile } from './plausible.js';
import { parseUmami, readText } from './umami.js';

// chokh-import: history from another analytics tool into a Chokh site.
//
//   chokh-import <plausible|umami|ga4> --site <id> [--id <import>] [--website <uuid>] [--apply] <file or folder>...
//   chokh-import --list --site <id>
//   chokh-import --remove <import> --site <id> [--apply]
//
// Nothing changes without --apply. Without it the command prints what it would
// do, day by day, and writes nothing. With it, it writes the new and changed
// days only, so a second run of the same files writes nothing. Everything goes
// through the store's import methods; nothing here knows a database.

export const SOURCES = ['plausible', 'umami', 'ga4'] as const;
export type Source = (typeof SOURCES)[number];

export const USAGE = [
  'chokh-import <plausible|umami|ga4> --site <id> [--id <import>] [--website <uuid>] [--apply] <file or folder>...',
  'chokh-import --list --site <id>',
  'chokh-import --remove <import> --site <id> [--apply]',
].join('\n');

export interface CommandDeps {
  store: AnalyticsStore;
  print(line: string): void;
  now(): number;
}

interface Args {
  source?: Source;
  site?: string;
  id?: string;
  website?: string;
  remove?: string;
  list: boolean;
  apply: boolean;
  paths: string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { list: false, apply: false, paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--apply') args.apply = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--site') args.site = value();
    else if (arg === '--id') args.id = value();
    else if (arg === '--website') args.website = value();
    else if (arg === '--remove') args.remove = value();
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (args.source === undefined && args.paths.length === 0 && SOURCES.some((source) => source === arg)) {
      args.source = SOURCES.find((source) => source === arg);
    } else args.paths.push(arg);
  }
  return args;
}

const FILE_FOR: Readonly<Record<Source, RegExp>> = {
  plausible: /^imported_.*\.csv$/i,
  umami: /^(website_event|session).*\.csv(\.gz)?$/i,
  ga4: /\.json$/i,
};

// The files named, and in a folder named the ones the source writes.
async function readSources(source: Source, paths: readonly string[]): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const path of paths) {
    const info = await stat(path);
    const names = info.isDirectory()
      ? (await readdir(path)).filter((name) => FILE_FOR[source].test(name)).sort().map((name) => join(path, name))
      : [path];
    for (const name of names) {
      files.push({ name: basename(name), text: readText(name, await readFile(name)) });
    }
  }
  if (files.length === 0) throw new Error(`no ${source} files in ${paths.join(', ')}`);
  return files;
}

const number = (value: number): string => value.toLocaleString('en-US');

// 1 day, 2 days; 1 row, 3 rows.
const counted = (value: number, word: string): string => `${number(value)} ${word}${value === 1 ? '' : 's'}`;

function span(days: readonly DayPlan[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  return first === undefined || last === undefined ? '' : ` (${first.date} to ${last.date})`;
}

function describeRefusal(day: DayPlan): string {
  const refusal = day.refusal;
  if (refusal === undefined) return day.date;
  if (refusal.reason === 'own_data') return `${day.date} the site has data of its own`;
  if (refusal.reason === 'recent') return `${day.date} too recent, the site can still collect it`;
  return `${day.date} held by import "${refusal.heldBy ?? ''}"`;
}

export async function runImportCommand(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const { store, print } = deps;
  const args = parseArgs(argv);
  if (args.site === undefined) throw new Error(`--site is required\n${USAGE}`);
  const site = await store.site(args.site);
  if (site === null) throw new Error(`no site answers to ${args.site}`);

  if (args.list) {
    const state = await store.importState(site.id);
    print(`Site ${site.id}: data of its own from ${state.ownFrom ?? 'no day yet'}.`);
    if (state.imports.length === 0) print('No imports.');
    for (const entry of state.imports) {
      print(`  ${entry.importId}: ${entry.from} to ${entry.to}, ${counted(entry.days, 'day')}, ${counted(entry.rows, 'row')}`);
    }
    return 0;
  }

  if (args.remove !== undefined) {
    checkImportId(args.remove);
    const rows = await store.importedRollups(site.id, args.remove);
    const days = new Set(rows.map((row) => row.date)).size;
    if (!args.apply) {
      print(`Would remove import "${args.remove}" from ${site.id}: ${counted(days, 'day')}, ${counted(rows.length, 'row')}.`);
      print('Dry run: nothing was removed. Run again with --apply to remove it.');
      return 0;
    }
    const removed = await store.removeImport(site.id, args.remove);
    print(`Removed import "${removed.importId}" from ${site.id}: ${counted(removed.days, 'day')}, ${counted(removed.rows, 'row')}.`);
    return 0;
  }

  if (args.source === undefined) throw new Error(`name a source: ${SOURCES.join(', ')}\n${USAGE}`);
  if (args.paths.length === 0) throw new Error(`name the files or the folder to import\n${USAGE}`);
  const importId = args.id ?? args.source;
  checkImportId(importId);

  const files = await readSources(args.source, args.paths);
  const timezone = site.settings.timezone;
  let parsed: ParsedImport;
  if (args.source === 'plausible') parsed = parsePlausible(files);
  else if (args.source === 'ga4') parsed = parseGa4(files);
  else parsed = parseUmami(files, { timezone, ...(args.website === undefined ? {} : { website: args.website }) });

  const incoming: ImportRow[] = parsed.rows.rows(site.settings.routeGroups);
  checkImportRows(incoming);

  const state = await store.importState(site.id);
  const heldByOthers = new Map<string, string>();
  for (const other of state.imports) {
    if (other.importId === importId) continue;
    for (const row of await store.importedRollups(site.id, other.importId)) {
      if (row.dim === 'total') heldByOthers.set(row.date, other.importId);
    }
  }
  const existing = await store.importedRollups(site.id, importId);
  const plan = planImport({
    importId,
    incoming,
    existing,
    heldByOthers,
    ownFrom: state.ownFrom,
    now: deps.now(),
    timezone,
  });

  print(`Import "${importId}" from ${args.source} into site ${site.id} (time zone ${timezone}).`);
  for (const note of parsed.notes) print(`  ${note}`);
  for (const [reason, times] of parsed.rows.skipped) print(`  left out: ${reason} (${counted(times, 'row')})`);
  print(`  the site has data of its own from ${state.ownFrom ?? 'no day yet'}`);
  print(`  days in the files: ${number(plan.days.length)}${span(plan.days)}`);
  for (const status of ['new', 'changed', 'unchanged'] as const) {
    const days = plan.days.filter((day) => day.status === status);
    const rows = days.reduce((sum, day) => sum + day.rows, 0);
    print(`    ${status.padEnd(10)}${counted(days.length, 'day')}, ${counted(rows, 'row')}`);
  }
  const refused = plan.days.filter((day) => day.status === 'refused');
  print(`    ${'refused'.padEnd(10)}${counted(refused.length, 'day')}`);
  for (const day of refused.slice(0, 10)) print(`      ${describeRefusal(day)}`);
  if (refused.length > 10) print(`      and ${number(refused.length - 10)} more`);

  const dims = new Map<string, number>();
  for (const row of plan.toWrite) dims.set(row.dim, (dims.get(row.dim) ?? 0) + 1);
  if (dims.size > 0) {
    print(`  rows to write by dimension: ${[...dims].map(([dim, rows]) => `${dim} ${number(rows)}`).join(', ')}`);
    const totals = plan.toWrite.filter((row) => row.dim === 'total');
    const visitors = totals.reduce((sum, row) => sum + row.visitors, 0);
    const pageviews = totals.reduce((sum, row) => sum + row.pageviews, 0);
    print(`  those days hold ${number(visitors)} visitors (each day's added up) and ${number(pageviews)} pageviews`);
  }

  if (!args.apply) {
    print(
      plan.toWrite.length === 0
        ? 'Dry run: nothing to write.'
        : 'Dry run: nothing was written. Run again with --apply to write the new and changed days.',
    );
    return 0;
  }
  if (plan.toWrite.length === 0) {
    print('Nothing to write: every day is already imported as it is in these files.');
    return 0;
  }
  const written = await store.writeImport(site.id, importId, plan.toWrite);
  print(`Wrote ${counted(written.days, 'day')}, ${counted(written.rows, 'row')}, as import "${importId}".`);
  for (const refusal of written.refused) {
    print(`  refused at write time: ${describeRefusal({ date: refusal.date, status: 'refused', rows: 0, refusal })}`);
  }
  print(`Take it back out with: chokh-import --remove ${importId} --site ${site.id} --apply`);
  return 0;
}
