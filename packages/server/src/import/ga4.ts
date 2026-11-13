import type { Channel, RollupDim } from '../store/AnalyticsStore.js';
import { count, createAccumulator, deviceOf, isUnset } from './day-rows.js';
import type { ParsedImport, SourceFile } from './plausible.js';

// A GA4 report, as the Data API's runReport answers it (RunReportResponse in
// Google's reference: dimensionHeaders, metricHeaders, and rows of
// dimensionValues and metricValues), which is also what Google's Query Explorer
// downloads as JSON. The UI's CSV download is not read: its columns depend on
// the report and its numbers on the reader's locale.
//
// One file per report. Every report has the date dimension (YYYYMMDD, a day of
// the property's time zone, which the report's metadata names) and at most one
// more. A report with date alone gives the day's totals and is required; each
// other report gives one breakdown:
//
//   pagePath                         page, and route by the site's rules
//   landingPage                      entry
//   pageReferrer                     referrer
//   sessionDefaultChannelGroup       channel (GA4's groups mapped to Chokh's seven)
//   sessionManualSource ... AdContent  utm_source to utm_content (what the link's
//                                      UTM tags said, not GA4's guessed source)
//   countryId                        country (ISO 3166-1; country is a name, so not read)
//   region, city                     region, city (English names, as Chokh files them)
//   browser, operatingSystem         browser, os
//   deviceCategory                   device
//   languageCode                     lang
//   eventName                        event: visitors only, and GA4's automatic events left out
//
// Metrics: visitors from totalUsers (or activeUsers), pageviews from
// screenPageViews, visits from sessions, duration from averageSessionDuration
// times sessions. GA4 has no bounce count and its bounce is not Chokh's (GA4:
// a session that was not "engaged"; Chokh: a visit of one pageview), so bounces
// are sessions minus engagedSessions, or sessions times bounceRate, and the two
// bounce rates do not compare.

const BREAKDOWNS: Readonly<Record<string, RollupDim>> = {
  pagePath: 'page',
  landingPage: 'entry',
  pageReferrer: 'referrer',
  sessionDefaultChannelGroup: 'channel',
  sessionManualSource: 'utm_source',
  sessionManualMedium: 'utm_medium',
  sessionManualCampaignName: 'utm_campaign',
  sessionManualTerm: 'utm_term',
  sessionManualAdContent: 'utm_content',
  countryId: 'country',
  region: 'region',
  city: 'city',
  browser: 'browser',
  operatingSystem: 'os',
  deviceCategory: 'device',
  languageCode: 'lang',
  eventName: 'event',
};

// GA4's default channel groups in Chokh's seven. A group with no counterpart
// (Unassigned, Audio, SMS, Mobile Push Notifications) is left out.
const CHANNELS: Readonly<Record<string, Channel>> = {
  direct: 'direct',
  'organic search': 'organic',
  'organic shopping': 'organic',
  'organic video': 'organic',
  'organic social': 'social',
  referral: 'referral',
  email: 'email',
  'paid search': 'paid',
  'paid social': 'paid',
  'paid shopping': 'paid',
  'paid video': 'paid',
  'paid other': 'paid',
  display: 'paid',
  'cross-network': 'paid',
  affiliates: 'paid',
};

// Events GA4 sends by itself; a site's own events are the ones worth a row.
const AUTOMATIC_EVENTS = new Set([
  'page_view',
  'session_start',
  'first_visit',
  'user_engagement',
  'scroll',
  'click',
  'view_search_results',
  'file_download',
  'form_start',
  'form_submit',
  'video_start',
  'video_progress',
  'video_complete',
]);

interface Report {
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: { name?: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  metadata?: { timeZone?: string };
}

function day(value: string | undefined): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value ?? '');
  return match === null ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
}

function language(code: string): string {
  const [base, region] = code.split('-');
  return region === undefined ? (base ?? code) : `${base}-${region.toUpperCase()}`;
}

export function parseGa4(files: readonly SourceFile[]): ParsedImport {
  const rows = createAccumulator();
  const notes: string[] = [];
  let totals = false;
  const zones = new Set<string>();

  for (const file of files) {
    let report: Report;
    try {
      report = JSON.parse(file.text) as Report;
    } catch {
      throw new Error(`${file.name} is not JSON`);
    }
    const dimensions = (report.dimensionHeaders ?? []).map((header) => header.name ?? '');
    const metrics = (report.metricHeaders ?? []).map((header) => header.name ?? '');
    const dateAt = dimensions.indexOf('date');
    if (dateAt < 0 || dimensions.length > 2) {
      throw new Error(`${file.name}: a report needs the date dimension and at most one other, it has ${dimensions.join(', ') || 'none'}`);
    }
    const otherAt = dimensions.length === 2 ? 1 - dateAt : -1;
    const otherName = otherAt < 0 ? undefined : dimensions[otherAt];
    const dim: RollupDim | undefined = otherName === undefined ? 'total' : BREAKDOWNS[otherName];
    if (dim === undefined) {
      throw new Error(`${file.name}: GA4's ${otherName ?? ''} has no Chokh dimension (see the README for the ones read)`);
    }
    if (report.metadata?.timeZone !== undefined) zones.add(report.metadata.timeZone);
    const metric = (values: { value?: string }[], name: string): number | undefined => {
      const at = metrics.indexOf(name);
      return at < 0 ? undefined : count(values[at]?.value);
    };
    const list = report.rows ?? [];
    notes.push(`${file.name}: ${list.length} rows (${otherName ?? 'date only, the totals'})`);
    if (dim === 'total') totals = true;

    for (const row of list) {
      const dimensionValues = row.dimensionValues ?? [];
      const values = row.metricValues ?? [];
      const date = day(dimensionValues[dateAt]?.value);
      if (date === undefined) {
        rows.skip('a GA4 row whose date is not YYYYMMDD');
        continue;
      }
      const sessions = metric(values, 'sessions') ?? 0;
      const engaged = metric(values, 'engagedSessions');
      const bounceRate = metric(values, 'bounceRate');
      const average = metric(values, 'averageSessionDuration') ?? 0;
      const visitors = metric(values, 'totalUsers') ?? metric(values, 'activeUsers') ?? 0;
      const visitTotals = {
        visitors,
        pageviews: metric(values, 'screenPageViews') ?? 0,
        visits: sessions,
        bounces: engaged !== undefined ? Math.max(0, sessions - engaged) : Math.round(sessions * (bounceRate ?? 0)),
        durationSum: average * sessions * 1000,
      };
      if (dim === 'total') {
        rows.add(date, 'total', '', visitTotals);
        continue;
      }
      const raw = dimensionValues[otherAt]?.value ?? '';
      if (isUnset(raw)) {
        rows.skip(`a ${otherName ?? ''} row of "(not set)"`);
        continue;
      }
      switch (dim) {
        case 'page':
          rows.add(date, 'page', raw, { visitors, pageviews: visitTotals.pageviews });
          break;
        case 'event':
          if (AUTOMATIC_EVENTS.has(raw)) rows.skip("one of GA4's automatic events");
          else rows.add(date, 'event', raw, { visitors });
          break;
        case 'channel': {
          const channel = CHANNELS[raw.toLowerCase()];
          if (channel === undefined) rows.skip(`a channel group Chokh has no name for (${raw})`);
          else rows.add(date, 'channel', channel, visitTotals);
          break;
        }
        case 'device': {
          const device = deviceOf(raw);
          if (device === undefined) rows.skip(`a device Chokh does not file (${raw})`);
          else rows.add(date, 'device', device, visitTotals);
          break;
        }
        case 'country':
          rows.add(date, 'country', raw.toUpperCase(), visitTotals);
          break;
        case 'lang':
          rows.add(date, 'lang', language(raw), visitTotals);
          break;
        default:
          rows.add(date, dim, raw, visitTotals);
      }
    }
  }

  if (!totals) {
    throw new Error('no report with the date dimension alone: without it no day has totals, and every imported day would read as empty');
  }
  if (zones.size > 0) notes.push(`GA4 property time zone: ${[...zones].join(', ')}`);
  notes.push("Bounces are GA4's sessions that were not engaged, which is not Chokh's one-pageview bounce.");
  return { rows, notes };
}
