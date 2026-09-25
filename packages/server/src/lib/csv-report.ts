import { csvDocument, type Cell } from './csv.js';
import type {
  BreakdownResult,
  Conversion,
  EngagementResult,
  EventRow,
  EventsResult,
  Funnel,
  FunnelResult,
  Goal,
  GoalStatsResult,
  JourneyResult,
  Metrics,
  PropertyResult,
  TimeseriesResult,
} from '../store/AnalyticsStore.js';

// Every report as a table, written once (AN-RPT01).
//
// One column set per report kind, fixed: a file whose columns depend on what
// the range happened to hold is a file nobody can append to last week's. The
// only variable part is the four conversion columns a breakdown carries when
// it was asked with a goal, which the JSON carries the same way. Numbers stay
// numbers and an unknown rate stays blank, never zero, for the same reason the
// JSON answers null: a spreadsheet averaging invented zeroes is a report that
// is wrong.

export const REPORT_KINDS = [
  'breakdown',
  'timeseries',
  'engagement',
  'events',
  'properties',
  'goals',
  'funnel',
  'journeys',
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (REPORT_KINDS as readonly string[]).includes(value);
}

export interface CsvTable {
  header: readonly string[];
  rows: Cell[][];
}

const METRIC_HEADER = [
  'visitors',
  'pageviews',
  'visits',
  'bounces',
  'bounce_rate',
  'avg_duration_ms',
] as const;

// Four more when the export was asked with a goal, the same four the JSON row
// carries under conversion. Only then: a file with a conversion rate column
// full of blanks reads as a goal nobody reached.
const CONVERSION_HEADER = ['converted_visitors', 'completions', 'conversion_rate', 'value'] as const;

function metricCells(metrics: Metrics): Cell[] {
  return [
    metrics.visitors,
    metrics.pageviews,
    metrics.visits,
    metrics.bounces,
    metrics.bounceRate,
    metrics.avgDurationMs,
  ];
}

function conversionCells(conversion: Conversion | undefined): Cell[] {
  return [
    conversion?.visitors ?? 0,
    conversion?.completions ?? 0,
    conversion?.rate ?? null,
    conversion?.value ?? null,
  ];
}

// A key the store left empty is the row for "did not carry it", drawn as
// unknown on the dashboard. A blank cell in a file reads as a missing value,
// so the word goes in the cell.
const UNKNOWN = '(unknown)';

function iso(at: number): string {
  return new Date(at).toISOString();
}

export function breakdownTable(result: BreakdownResult, withGoal: boolean): CsvTable {
  return {
    header: withGoal ? ['key', ...METRIC_HEADER, ...CONVERSION_HEADER] : ['key', ...METRIC_HEADER],
    rows: result.rows.map((row) =>
      withGoal
        ? [row.key, ...metricCells(row.metrics), ...conversionCells(row.conversion)]
        : [row.key, ...metricCells(row.metrics)],
    ),
  };
}

// One row per bucket. The previous series, when the query compared, follows
// the current one under its own series name rather than beside it: the two
// have the same number of buckets by construction, but a file with twelve
// numeric columns is a file somebody misreads.
export function timeseriesTable(result: TimeseriesResult): CsvTable {
  const rows = result.points.map((point) => [
    'current',
    iso(point.start),
    iso(point.end),
    ...metricCells(point.metrics),
  ]);
  for (const point of result.previous ?? []) {
    rows.push(['previous', iso(point.start), iso(point.end), ...metricCells(point.metrics)]);
  }
  return { header: ['series', 'start', 'end', ...METRIC_HEADER], rows };
}

export function engagementTable(result: EngagementResult): CsvTable {
  return {
    header: ['key', 'avg_time_on_page_ms', 'avg_scroll_depth', 'leaves'],
    rows: result.rows.map((row) => [row.key, row.avgTimeOnPageMs, row.avgScrollDepth, row.leaves]),
  };
}

function eventCells(row: EventRow): Cell[] {
  return [row.key === '' ? UNKNOWN : row.key, row.visitors, row.events, row.rate];
}

export function eventsTable(result: EventsResult): CsvTable {
  return { header: ['key', 'visitors', 'events', 'rate'], rows: result.rows.map(eventCells) };
}

// The event and the property are on every row, so a file for "signup by plan"
// says so in itself and not only in its name.
export function propertiesTable(result: PropertyResult): CsvTable {
  return {
    header: ['event', 'property', 'key', 'visitors', 'events', 'rate'],
    rows: result.rows.map((row) => [result.event, result.property ?? UNKNOWN, ...eventCells(row)]),
  };
}

export function goalsTable(result: GoalStatsResult, goals: readonly Goal[]): CsvTable {
  const byId = new Map(goals.map((goal) => [goal.id, goal.name]));
  return {
    header: ['goal_id', 'goal', ...CONVERSION_HEADER],
    rows: result.rows.map((row) => [
      row.goalId,
      byId.get(row.goalId) ?? UNKNOWN,
      ...conversionCells(row.conversion),
    ]),
  };
}

export function funnelTable(result: FunnelResult, funnel: Funnel): CsvTable {
  return {
    header: ['step', 'name', 'visitors', 'drop_off', 'rate', 'step_rate'],
    rows: result.steps.map((step, index) => [
      index + 1,
      funnel.steps[index]?.name ?? UNKNOWN,
      step.visitors,
      step.dropOff,
      step.rate,
      step.stepRate,
    ]),
  };
}

// One row per branch: the visits that went from a page in one column to a
// page in the next. The column's Other is named as such rather than left
// blank, for the same reason as an unknown key.
export function journeysTable(result: JourneyResult): CsvTable {
  return {
    header: ['column', 'from', 'to', 'visits'],
    rows: result.links.map((link) => [
      link.column,
      link.from ?? '(other)',
      link.to ?? '(other)',
      link.visits,
    ]),
  };
}

export function csvOf(table: CsvTable): string {
  return csvDocument(table.header, table.rows);
}
