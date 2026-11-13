import { classifyChannel, type Attributes } from '../store/AnalyticsStore.js';
import { csvRecords } from './csv.js';
import { count, createAccumulator, deviceOf, isUnset, type Accumulator } from './day-rows.js';

// Plausible's CSV format: the files its own "Export to CSV" writes and its CSV
// import reads, one table per file, named imported_<table>_<YYYYMMDD>_<YYYYMMDD>.csv
// (plausible.io/docs/csv-import). Every row is one day of one table, already
// counted: visitors, visits, bounces and pageviews are counts, visit_duration is
// the total in seconds. The days are days of the Plausible site's time zone.
//
// What each table becomes:
//
//   imported_visitors          the day's totals (required: a day without them reads as empty)
//   imported_pages             page, and route by the site's rules
//   imported_entry_pages       entry
//   imported_exit_pages        exit
//   imported_sources           referrer, utm_source to utm_content, and the channel
//                              Chokh's own classifier gives the referrer and UTM
//                              (Plausible's CSV has no channel column)
//   imported_locations         country (ISO 3166-1, as Chokh files it). Not region:
//                              Plausible writes an ISO 3166-2 code where Chokh files
//                              an English name. Not city: Plausible writes a GeoNames id.
//   imported_devices           device (Laptop is filed as desktop, as the collector does)
//   imported_browsers          browser, versions added together
//   imported_operating_systems os, versions added together
//   imported_custom_events     event: visitors only, which is all a rolled event row holds
//
// A table's rows are added up into Chokh's keys, so where Plausible splits one
// key further (a page per hostname, a browser per version, a source per
// referrer path) the visitors are added and a person in two of the splits
// counts twice, as Plausible's own import counts them.

export interface SourceFile {
  name: string;
  text: string;
}

export const PLAUSIBLE_TABLES = [
  'visitors',
  'sources',
  'pages',
  'entry_pages',
  'exit_pages',
  'custom_events',
  'locations',
  'devices',
  'browsers',
  'operating_systems',
] as const;

type Table = (typeof PLAUSIBLE_TABLES)[number];

const FILE_NAME = /^imported_([a-z_]+?)(?:_\d{8}_\d{8})?\.csv$/;

export function plausibleTable(fileName: string): Table | undefined {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const match = FILE_NAME.exec(base);
  const table = match?.[1];
  return PLAUSIBLE_TABLES.find((candidate) => candidate === table);
}

function visit(record: Record<string, string>, visitsColumn = 'visits') {
  return {
    visitors: count(record.visitors),
    pageviews: count(record.pageviews),
    visits: count(record[visitsColumn]),
    bounces: count(record.bounces),
    durationSum: count(record.visit_duration) * 1000,
  };
}

const UTM_COLUMNS = ['source', 'medium', 'campaign', 'content', 'term'] as const;

export interface ParsedImport {
  rows: Accumulator;
  // What the report says before the plan: which files were read, what was not.
  notes: string[];
}

export function parsePlausible(files: readonly SourceFile[]): ParsedImport {
  const rows = createAccumulator();
  const notes: string[] = [];
  const seen = new Set<Table>();

  for (const file of files) {
    const table = plausibleTable(file.name);
    if (table === undefined) {
      throw new Error(`${file.name} is not a Plausible export file (imported_<table>_<start>_<end>.csv)`);
    }
    seen.add(table);
    const { header, records } = csvRecords(file.text);
    if (!header.includes('date')) {
      throw new Error(`${file.name} has no date column`);
    }
    notes.push(`${file.name}: ${records.length} rows (${table})`);

    for (const record of records) {
      const date = record.date ?? '';
      switch (table) {
        case 'visitors':
          rows.add(date, 'total', '', visit(record));
          break;
        case 'pages': {
          if (isUnset(record.page)) {
            rows.skip('a page row with no page');
            break;
          }
          rows.add(date, 'page', record.page as string, {
            visitors: count(record.visitors),
            pageviews: count(record.pageviews),
          });
          break;
        }
        case 'entry_pages':
          if (isUnset(record.entry_page)) rows.skip('an entry page row with no page');
          else rows.add(date, 'entry', record.entry_page as string, visit(record, 'entrances'));
          break;
        case 'exit_pages':
          if (isUnset(record.exit_page)) rows.skip('an exit page row with no page');
          else rows.add(date, 'exit', record.exit_page as string, visit(record, 'exits'));
          break;
        case 'sources': {
          const totals = visit(record);
          const referrer = isUnset(record.referrer) ? undefined : `https://${(record.referrer as string).replace(/^https?:\/\//, '')}`;
          if (referrer !== undefined) rows.add(date, 'referrer', referrer, totals);
          const utm: Attributes = {};
          for (const name of UTM_COLUMNS) {
            const value = record[`utm_${name}`];
            if (!isUnset(value)) {
              utm[name] = value as string;
              rows.add(date, `utm_${name}`, value as string, totals);
            }
          }
          rows.add(
            date,
            'channel',
            classifyChannel({ ...(referrer === undefined ? {} : { referrer }), utm }),
            totals,
          );
          break;
        }
        case 'locations':
          if (isUnset(record.country)) rows.skip('a location with no country');
          else rows.add(date, 'country', (record.country as string).toUpperCase(), visit(record));
          break;
        case 'devices': {
          const device = deviceOf(record.device);
          if (device === undefined) rows.skip(`a device Chokh does not file (${record.device ?? ''})`);
          else rows.add(date, 'device', device, visit(record));
          break;
        }
        case 'browsers':
          if (isUnset(record.browser)) rows.skip('a browser row with no browser');
          else rows.add(date, 'browser', record.browser as string, visit(record));
          break;
        case 'operating_systems':
          if (isUnset(record.operating_system)) rows.skip('an operating system row with no name');
          else rows.add(date, 'os', record.operating_system as string, visit(record));
          break;
        case 'custom_events':
          if (isUnset(record.name)) rows.skip('an event row with no name');
          else rows.add(date, 'event', record.name as string, { visitors: count(record.visitors) });
          break;
      }
    }
  }

  if (!seen.has('visitors')) {
    throw new Error('imported_visitors is missing: without it no day has totals, and every imported day would read as empty');
  }
  notes.push(
    'Not imported: region (Plausible writes an ISO 3166-2 code, Chokh files a name) and city (Plausible writes a GeoNames id).',
  );
  return { rows, notes };
}
