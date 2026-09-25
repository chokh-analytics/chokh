import type {
  AccountStore,
  AnalyticsStore,
  Annotation,
  BreakdownRow,
  Conversion,
  Digest,
  Goal,
  Metrics,
  Site,
  TimeseriesPoint,
} from '@chokh/store';

import type { Mail } from '../alerts/deliver.js';
import { renderDigestPdf } from './pdf.js';
import type { DigestPeriod } from './period.js';

// What a digest says (AN-RPT01): the period's numbers against the period
// before, the daily shape, the top five pages, sources and countries, the
// goals, and the marks on the chart, composed from the same reads the
// Overview makes and written once as text, once as HTML and once as a page.

export interface DigestReport {
  site: Pick<Site, 'id' | 'name'>;
  cadence: Digest['cadence'];
  period: DigestPeriod;
  metrics: Metrics;
  previous: Metrics | null;
  series: TimeseriesPoint[];
  pages: BreakdownRow[];
  channels: BreakdownRow[];
  countries: BreakdownRow[];
  goals: { name: string; conversion: Conversion }[];
  annotations: Annotation[];
}

const TOP = 5;

export async function composeDigest(
  store: AnalyticsStore & AccountStore,
  site: Site,
  digest: Pick<Digest, 'cadence'>,
  period: DigestPeriod,
): Promise<DigestReport> {
  const base = { siteId: site.id, from: period.from, to: period.to };
  const [totals, series, pages, channels, countries, goals, annotations] = await Promise.all([
    store.aggregate({ ...base, compare: 'previous_period' }),
    store.timeseries({ ...base, interval: digest.cadence === 'daily' ? 'hour' : 'day' }),
    store.breakdown({ ...base, dim: 'page', limit: TOP }),
    store.breakdown({ ...base, dim: 'channel', limit: TOP }),
    store.breakdown({ ...base, dim: 'country', limit: TOP }),
    store.goals(site.id),
    store.annotations(site.id, period.from, period.to),
  ]);
  const conversions =
    goals.length === 0 ? { rows: [] } : await store.goalStats({ ...base }, goals);
  const byId = new Map(goals.map((goal: Goal) => [goal.id, goal.name]));
  return {
    site: { id: site.id, name: site.name },
    cadence: digest.cadence,
    period,
    metrics: totals.metrics,
    previous: totals.previous,
    series: series.points,
    pages: pages.rows,
    channels: channels.rows,
    countries: countries.rows,
    goals: conversions.rows.map((row) => ({
      name: byId.get(row.goalId) ?? row.goalId,
      conversion: row.conversion,
    })),
    annotations,
  };
}

// ── Words ─────────────────────────────────────────────────────────────────

const GROUPED = new Intl.NumberFormat('en-US');

export function count(value: number): string {
  return GROUPED.format(Math.round(value));
}

export function rate(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

export function duration(ms: number | null): string {
  if (ms === null) return 'n/a';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

// "+12%" against the period before, or "n/a" against nothing.
export function change(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return 'n/a';
  if (previous === 0) return current === 0 ? 'no change' : 'new';
  const percent = Math.round(((current - previous) / previous) * 100);
  return percent === 0 ? 'no change' : `${percent > 0 ? '+' : ''}${percent}%`;
}

export const CHANNEL_WORDS: Record<string, string> = {
  direct: 'Direct',
  organic: 'Organic search',
  social: 'Social',
  referral: 'Referral',
  email: 'Email',
  paid: 'Paid',
  ai: 'AI assistants',
};

function keyWords(dim: 'page' | 'channel' | 'country', key: string): string {
  if (key === '') return 'Unknown';
  return dim === 'channel' ? (CHANNEL_WORDS[key] ?? key) : key;
}

export function periodWords(report: Pick<DigestReport, 'cadence' | 'period'>): string {
  return report.cadence === 'daily'
    ? report.period.lastDay
    : `${report.period.firstDay} to ${report.period.lastDay}`;
}

export function subjectFor(report: DigestReport): string {
  return report.cadence === 'daily'
    ? `Chokh: ${report.site.name} on ${report.period.lastDay}`
    : `Chokh: ${report.site.name}, the week to ${report.period.lastDay}`;
}

export interface Line {
  label: string;
  value: string;
  change: string;
}

export function headline(report: DigestReport): Line[] {
  const { metrics, previous } = report;
  return [
    { label: 'Visitors', value: count(metrics.visitors), change: change(metrics.visitors, previous?.visitors ?? null) },
    { label: 'Pageviews', value: count(metrics.pageviews), change: change(metrics.pageviews, previous?.pageviews ?? null) },
    { label: 'Visits', value: count(metrics.visits), change: change(metrics.visits, previous?.visits ?? null) },
    {
      label: 'Bounce rate',
      value: rate(metrics.bounceRate),
      change: change(metrics.bounceRate, previous?.bounceRate ?? null),
    },
    {
      label: 'Avg visit',
      value: duration(metrics.avgDurationMs),
      change: change(metrics.avgDurationMs, previous?.avgDurationMs ?? null),
    },
  ];
}

export function topLines(dim: 'page' | 'channel' | 'country', rows: BreakdownRow[]): Line[] {
  return rows.map((row) => ({
    label: keyWords(dim, row.key),
    value: count(row.metrics.visitors),
    change: '',
  }));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textTable(title: string, lines: Line[]): string {
  if (lines.length === 0) return `${title}\n  (nothing)\n`;
  const width = Math.max(...lines.map((line) => line.label.length));
  return `${title}\n${lines
    .map((line) => `  ${line.label.padEnd(width)}  ${line.value}${line.change === '' ? '' : `  (${line.change})`}`)
    .join('\n')}\n`;
}

function htmlTable(title: string, lines: Line[], withChange: boolean): string {
  const rows =
    lines.length === 0
      ? `<tr><td colspan="3" style="color:#6b7280">nothing</td></tr>`
      : lines
          .map(
            (line) =>
              `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(line.label)}</td>` +
              `<td style="padding:4px 12px 4px 0;text-align:right;font-variant-numeric:tabular-nums"><strong>${escapeHtml(line.value)}</strong></td>` +
              (withChange ? `<td style="padding:4px 0;color:#6b7280">${escapeHtml(line.change)}</td>` : '') +
              `</tr>`,
          )
          .join('');
  return `<h3 style="margin:20px 0 6px;font-size:14px">${escapeHtml(title)}</h3><table style="border-collapse:collapse;font-size:14px">${rows}</table>`;
}

export function digestText(report: DigestReport, link: string | null): string {
  const parts = [
    `${report.site.name}, ${periodWords(report)}${report.previous === null ? '' : ' (against the period before)'}`,
    '',
    textTable('The numbers', headline(report)),
    textTable('Top pages', topLines('page', report.pages)),
    textTable('Sources', topLines('channel', report.channels)),
    textTable('Countries', topLines('country', report.countries)),
    textTable(
      'Goals',
      report.goals.map((goal) => ({
        label: goal.name,
        value: `${count(goal.conversion.visitors)} converted`,
        change: rate(goal.conversion.rate),
      })),
    ),
  ];
  if (report.annotations.length > 0) {
    parts.push(
      textTable(
        'Marks on the chart',
        report.annotations.map((mark) => ({ label: mark.kind, value: mark.text, change: '' })),
      ),
    );
  }
  if (link !== null) {
    parts.push(`Open the dashboard: ${link}`);
  }
  parts.push('The same numbers are in the attached PDF.');
  return parts.join('\n');
}

export function digestHtml(report: DigestReport, link: string | null): string {
  const marks =
    report.annotations.length === 0
      ? ''
      : htmlTable(
          'Marks on the chart',
          report.annotations.map((mark) => ({ label: mark.kind, value: mark.text, change: '' })),
          false,
        );
  return (
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;max-width:560px">` +
    `<h2 style="margin:0 0 4px;font-size:18px">${escapeHtml(report.site.name)}</h2>` +
    `<p style="margin:0 0 12px;color:#6b7280;font-size:13px">${escapeHtml(periodWords(report))}${report.previous === null ? '' : ', against the period before'}</p>` +
    htmlTable('The numbers', headline(report), true) +
    htmlTable('Top pages', topLines('page', report.pages), false) +
    htmlTable('Sources', topLines('channel', report.channels), false) +
    htmlTable('Countries', topLines('country', report.countries), false) +
    htmlTable(
      'Goals',
      report.goals.map((goal) => ({
        label: goal.name,
        value: `${count(goal.conversion.visitors)} converted`,
        change: rate(goal.conversion.rate),
      })),
      true,
    ) +
    marks +
    (link === null ? '' : `<p style="margin:20px 0 0"><a href="${escapeHtml(link)}">Open the dashboard</a></p>`) +
    `<p style="margin:12px 0 0;color:#6b7280;font-size:12px">The same numbers are in the attached PDF. Sent by Chokh.</p>` +
    `</div>`
  );
}

export async function digestMail(report: DigestReport, publicUrl: string | undefined): Promise<Mail> {
  const link = publicUrl === undefined ? null : `${publicUrl}/${report.site.id}`;
  const pdf = await renderDigestPdf(report);
  const name = `${report.site.id}-${report.cadence}-${report.period.lastDay}.pdf`;
  return {
    subject: subjectFor(report),
    text: digestText(report, link),
    html: digestHtml(report, link),
    attachments: [{ name, content: pdf, type: 'application/pdf' }],
  };
}
