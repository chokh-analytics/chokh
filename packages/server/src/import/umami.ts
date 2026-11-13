import { gunzipSync } from 'node:zlib';

import { classifyChannel, dayKey, type Attributes, type RollupDim } from '../store/AnalyticsStore.js';
import { csvRecords } from './csv.js';
import { createAccumulator, deviceOf, isUnset } from './day-rows.js';
import type { ParsedImport, SourceFile } from './plausible.js';

// Umami's export is not aggregates: Umami Cloud's "Export data" (and a
// self-hosted install's database) is its raw tables as CSV, columns named as in
// Umami's published Prisma schema. Two are read:
//
//   website_event  one row per pageview (event_type 1) or custom event (2):
//                  session_id, visit_id, created_at, url_path, url_query,
//                  referrer_domain, referrer_path, utm_* (or the UTM in
//                  url_query, for an export from before Umami had the columns),
//                  event_name, website_id
//   session        one row per session: browser, os, device, screen, language,
//                  country, region, city
//
// So this importer counts, the way Chokh counts, into days of the Chokh site's
// time zone (created_at is an instant): visitors are distinct session_id per
// day, visits distinct visit_id by the day they began, a bounce a visit of one
// pageview, a visit's time its first row to its last, entry and exit its first
// and last page, its referrer, UTM and channel those of its first row. And then
// writes rollup rows, like the other two sources, never events.
//
// Not read: region (Umami writes an ISO 3166-2 code, Chokh files a name), and
// event_data and session_data (properties, which no rollup holds).

interface Visit {
  sessionId: string;
  day: string;
  first: number;
  last: number;
  pageviews: number;
  entry?: string;
  exit?: string;
  referrer?: string;
  utm: Attributes;
}

interface Session {
  browser?: string;
  os?: string;
  device?: string;
  screen?: string;
  lang?: string;
  country?: string;
  city?: string;
}

// The browser ids Umami's detector writes, in the names a browser reports to
// Chokh's collector. An id not here is kept as Umami wrote it.
const BROWSERS: Readonly<Record<string, string>> = {
  chrome: 'Chrome',
  crios: 'Chrome',
  'chromium-webview': 'Chrome WebView',
  firefox: 'Firefox',
  fxios: 'Firefox',
  safari: 'Safari',
  ios: 'Mobile Safari',
  'ios-webview': 'Mobile Safari',
  edge: 'Edge',
  'edge-chromium': 'Edge',
  'edge-ios': 'Edge',
  opera: 'Opera',
  'opera-mini': 'Opera Mini',
  samsung: 'Samsung Internet',
  yandexbrowser: 'Yandex',
  facebook: 'Facebook',
  instagram: 'Instagram',
};

const UTM = ['source', 'medium', 'campaign', 'term', 'content'] as const;

// created_at as Postgres or MySQL writes it to CSV ("2026-01-02 03:04:05.678+00",
// "2026-01-02 03:04:05") or as ISO 8601. A time with no zone is UTC, which is
// what Umami stores.
export function umamiInstant(value: string | undefined): number | undefined {
  const raw = (value ?? '').trim();
  if (raw === '') return undefined;
  let iso = raw.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(iso)) iso += ':00';
  else if (/[+-]\d{4}$/.test(iso)) iso = `${iso.slice(0, -2)}:${iso.slice(-2)}`;
  else if (!/(Z|[+-]\d{2}:\d{2})$/i.test(iso)) iso += 'Z';
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : undefined;
}

export function readText(name: string, bytes: Buffer): string {
  return (name.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
}

function kind(file: SourceFile): 'event' | 'session' | undefined {
  const base = (file.name.split(/[\\/]/).pop() ?? file.name).toLowerCase();
  if (base.startsWith('website_event')) return 'event';
  if (base.startsWith('session')) return 'session';
  return undefined;
}

export interface UmamiOptions {
  // The Chokh site's time zone: Umami's instants become its days.
  timezone: string;
  // Which Umami website, when the export holds more than one.
  website?: string;
}

export function parseUmami(files: readonly SourceFile[], options: UmamiOptions): ParsedImport {
  const rows = createAccumulator();
  const notes: string[] = [];
  const sessions = new Map<string, Session>();
  const events: Record<string, string>[] = [];

  for (const file of files) {
    const which = kind(file);
    if (which === undefined) {
      throw new Error(`${file.name} is neither a website_event nor a session export`);
    }
    const { records } = csvRecords(file.text);
    notes.push(`${file.name}: ${records.length} rows (${which === 'event' ? 'website_event' : 'session'})`);
    if (which === 'event') {
      events.push(...records);
      continue;
    }
    for (const record of records) {
      if (options.website !== undefined && record.website_id !== undefined && record.website_id !== options.website) continue;
      const session: Session = {};
      if (!isUnset(record.browser)) session.browser = BROWSERS[record.browser as string] ?? (record.browser as string);
      if (!isUnset(record.os)) session.os = record.os as string;
      const device = deviceOf(record.device);
      if (device !== undefined) session.device = device;
      if (!isUnset(record.screen)) session.screen = record.screen as string;
      if (!isUnset(record.language)) session.lang = record.language as string;
      if (!isUnset(record.country)) session.country = (record.country as string).toUpperCase();
      if (!isUnset(record.city)) session.city = record.city as string;
      sessions.set(record.session_id ?? '', session);
    }
  }
  if (events.length === 0) {
    throw new Error('no website_event rows: that file is the one with the pageviews');
  }

  const websites = new Set(events.map((record) => record.website_id ?? ''));
  websites.delete('');
  if (options.website === undefined && websites.size > 1) {
    throw new Error(`the export holds ${websites.size} websites (${[...websites].join(', ')}): name one with --website`);
  }

  const visits = new Map<string, Visit>();
  // Each day's distinct sessions, per dimension and value.
  const seen = new Map<string, { day: string; dim: RollupDim; key: string; sessions: Set<string> }>();
  const visitor = (day: string, dim: RollupDim, key: string, sessionId: string): void => {
    const id = `${day}\n${dim}\n${key}`;
    const cell = seen.get(id) ?? { day, dim, key, sessions: new Set<string>() };
    cell.sessions.add(sessionId);
    seen.set(id, cell);
  };

  const ordered = events
    .filter((record) => options.website === undefined || record.website_id === options.website)
    .map((record) => ({ record, at: umamiInstant(record.created_at) }))
    .filter((entry): entry is { record: Record<string, string>; at: number } => {
      if (entry.at === undefined) rows.skip('an event with no readable created_at');
      return entry.at !== undefined;
    })
    .sort((left, right) => left.at - right.at);

  for (const { record, at } of ordered) {
    const type = record.event_type ?? '1';
    if (type !== '1' && type !== '2') {
      rows.skip(`an event of type ${type}, neither a pageview nor a custom event`);
      continue;
    }
    const sessionId = record.session_id ?? '';
    const visitId = record.visit_id === undefined || record.visit_id === '' ? sessionId : record.visit_id;
    const day = dayKey(at, options.timezone);
    const session = sessions.get(sessionId) ?? {};
    const path = record.url_path ?? '';
    const pageview = type === '1';

    let current = visits.get(visitId);
    if (current === undefined) {
      const utm: Attributes = {};
      const query = new URLSearchParams(record.url_query ?? '');
      for (const name of UTM) {
        const column = record[`utm_${name}`];
        const value = isUnset(column) ? (query.get(`utm_${name}`) ?? '') : (column as string);
        if (!isUnset(value)) utm[name] = value;
      }
      current = { sessionId, day, first: at, last: at, pageviews: 0, utm };
      if (!isUnset(record.referrer_domain)) {
        current.referrer = `https://${record.referrer_domain as string}${record.referrer_path || '/'}`;
      }
      visits.set(visitId, current);
    }
    current.last = at;

    visitor(day, 'total', '', sessionId);
    if (pageview) {
      current.pageviews += 1;
      current.entry ??= path;
      current.exit = path;
      rows.add(day, 'total', '', { pageviews: 1 });
      rows.add(day, 'page', path, { pageviews: 1 });
      visitor(day, 'page', path, sessionId);
      for (const [dim, key] of sessionKeys(session)) {
        rows.add(day, dim, key, { pageviews: 1 });
      }
    } else if (!isUnset(record.event_name)) {
      visitor(day, 'event', record.event_name as string, sessionId);
    }
    for (const [dim, key] of sessionKeys(session)) {
      visitor(day, dim, key, sessionId);
    }
  }

  // Visits, bounces and time, by the day each visit began, under every
  // dimension a visit has: its entry and exit, its source, its session's.
  for (const current of visits.values()) {
    const totals = {
      visits: 1,
      bounces: current.pageviews <= 1 ? 1 : 0,
      durationSum: current.last - current.first,
    };
    rows.add(current.day, 'total', '', totals);
    const own: [RollupDim, string][] = [];
    if (current.entry !== undefined) own.push(['entry', current.entry]);
    if (current.exit !== undefined) own.push(['exit', current.exit]);
    if (current.referrer !== undefined) own.push(['referrer', current.referrer]);
    for (const name of UTM) {
      const value = current.utm[name];
      if (value !== undefined) own.push([`utm_${name}`, value]);
    }
    own.push([
      'channel',
      classifyChannel({ ...(current.referrer === undefined ? {} : { referrer: current.referrer }), utm: current.utm }),
    ]);
    for (const [dim, key] of own) {
      rows.add(current.day, dim, key, { ...totals, pageviews: current.pageviews });
      visitor(current.day, dim, key, current.sessionId);
    }
    for (const [dim, key] of sessionKeys(sessions.get(current.sessionId) ?? {})) {
      if (dim === 'screen' || dim === 'lang') continue;
      rows.add(current.day, dim, key, totals);
    }
  }

  for (const cell of seen.values()) {
    rows.add(cell.day, cell.dim, cell.key, { visitors: cell.sessions.size });
  }
  notes.push(`Umami's instants counted into days of ${options.timezone}, the Chokh site's time zone.`);
  notes.push('Not imported: region (Umami writes an ISO 3166-2 code, Chokh files a name), event and session properties.');
  return { rows, notes };
}

function sessionKeys(session: Session): [RollupDim, string][] {
  const keys: [RollupDim, string][] = [];
  if (session.country !== undefined) keys.push(['country', session.country]);
  if (session.city !== undefined) keys.push(['city', session.city]);
  if (session.browser !== undefined) keys.push(['browser', session.browser]);
  if (session.os !== undefined) keys.push(['os', session.os]);
  if (session.device !== undefined) keys.push(['device', session.device]);
  if (session.screen !== undefined) keys.push(['screen', session.screen]);
  if (session.lang !== undefined) keys.push(['lang', session.lang]);
  return keys;
}
