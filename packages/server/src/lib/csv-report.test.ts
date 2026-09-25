import { describe, expect, it } from 'vitest';

import {
  breakdownTable,
  csvOf,
  engagementTable,
  eventsTable,
  funnelTable,
  goalsTable,
  isReportKind,
  journeysTable,
  propertiesTable,
  REPORT_KINDS,
  timeseriesTable,
} from './csv-report.js';
import type { Funnel, Goal, Metrics } from '../store/AnalyticsStore.js';

// Every report as a table (AN-RPT01): one fixed column set per kind, the
// numbers as the JSON answers them, blanks where the JSON answers null, and a
// word where a key is empty or a node is Other.

const metrics: Metrics = {
  visitors: 3,
  pageviews: 5,
  visits: 4,
  bounces: 2,
  bounceRate: 0.5,
  avgDurationMs: 1234,
};

const unknownMetrics: Metrics = { ...metrics, bounceRate: null, avgDurationMs: null };

describe('the report kinds', () => {
  it('names eight and refuses the rest', () => {
    expect(REPORT_KINDS).toHaveLength(8);
    expect(isReportKind('breakdown')).toBe(true);
    expect(isReportKind('journeys')).toBe(true);
    expect(isReportKind('people')).toBe(false);
    expect(isReportKind('realtime')).toBe(false);
    expect(isReportKind(undefined)).toBe(false);
  });
});

describe('breakdownTable', () => {
  it('is the key and the six metrics, with a blank for an unknown rate', () => {
    const table = breakdownTable(
      { dim: 'country', rows: [{ key: 'BD', metrics }, { key: 'IN', metrics: unknownMetrics }] },
      false,
    );
    expect(table.header).toEqual([
      'key',
      'visitors',
      'pageviews',
      'visits',
      'bounces',
      'bounce_rate',
      'avg_duration_ms',
    ]);
    expect(csvOf(table)).toBe(
      'key,visitors,pageviews,visits,bounces,bounce_rate,avg_duration_ms\r\nBD,3,5,4,2,0.5,1234\r\nIN,3,5,4,2,,\r\n',
    );
  });

  it('carries the four conversion columns when asked with a goal, zero for a row that has none', () => {
    const table = breakdownTable(
      {
        dim: 'country',
        rows: [
          { key: 'BD', metrics, conversion: { visitors: 2, completions: 2, rate: 1, value: 10 } },
          { key: 'IN', metrics },
        ],
      },
      true,
    );
    expect(table.header.slice(7)).toEqual([
      'converted_visitors',
      'completions',
      'conversion_rate',
      'value',
    ]);
    expect(table.rows[0]?.slice(7)).toEqual([2, 2, 1, 10]);
    expect(table.rows[1]?.slice(7)).toEqual([0, 0, null, null]);
  });
});

describe('timeseriesTable', () => {
  it('is one row per bucket with ISO instants, the compared series after the current one', () => {
    const start = Date.UTC(2026, 8, 18);
    const table = timeseriesTable({
      interval: 'day',
      points: [{ start, end: start + 86_400_000, metrics }],
      previous: [{ start: start - 86_400_000, end: start, metrics: unknownMetrics }],
    });
    expect(table.header).toEqual([
      'series',
      'start',
      'end',
      'visitors',
      'pageviews',
      'visits',
      'bounces',
      'bounce_rate',
      'avg_duration_ms',
    ]);
    expect(table.rows).toEqual([
      ['current', '2026-09-18T00:00:00.000Z', '2026-09-19T00:00:00.000Z', 3, 5, 4, 2, 0.5, 1234],
      ['previous', '2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z', 3, 5, 4, 2, null, null],
    ]);
  });

  it('has no previous rows when the query did not compare', () => {
    const table = timeseriesTable({ interval: 'hour', points: [], previous: null });
    expect(table.rows).toEqual([]);
  });
});

describe('the raw reports', () => {
  it('engagement is the key, the two averages and the leaves', () => {
    const table = engagementTable({
      dim: 'page',
      rows: [{ key: '/pricing', avgTimeOnPageMs: 62_000, avgScrollDepth: 75, leaves: 1 }],
      rawOnly: true,
    });
    expect(table.header).toEqual(['key', 'avg_time_on_page_ms', 'avg_scroll_depth', 'leaves']);
    expect(table.rows).toEqual([['/pricing', 62_000, 75, 1]]);
  });

  it('events is the name, the people, the count and the rate', () => {
    const table = eventsTable({
      visitors: 3,
      rows: [{ key: 'signup', visitors: 2, events: 2, rate: 2 / 3 }],
      rawOnly: true,
    });
    expect(table.header).toEqual(['key', 'visitors', 'events', 'rate']);
    expect(table.rows).toEqual([['signup', 2, 2, 2 / 3]]);
  });

  it('properties names the event and the property on every row, and an empty key as unknown', () => {
    const table = propertiesTable({
      event: 'signup',
      properties: [{ key: 'plan', events: 2 }],
      property: 'plan',
      visitors: 2,
      rows: [
        { key: 'pro', visitors: 1, events: 1, rate: 0.5 },
        { key: '', visitors: 1, events: 1, rate: 0.5 },
      ],
      rawOnly: true,
    });
    expect(table.header).toEqual(['event', 'property', 'key', 'visitors', 'events', 'rate']);
    expect(table.rows).toEqual([
      ['signup', 'plan', 'pro', 1, 1, 0.5],
      ['signup', 'plan', '(unknown)', 1, 1, 0.5],
    ]);
  });

  it('goals names each goal beside its id, and one deleted between the reads as unknown', () => {
    const goal: Goal = {
      siteId: 's',
      id: 'g_1',
      name: 'Signed up',
      kind: 'event',
      match: 'signup',
      createdBy: 'u',
      createdAt: 0,
    };
    const table = goalsTable(
      {
        visitors: 3,
        rows: [
          { goalId: 'g_1', conversion: { visitors: 2, completions: 2, rate: 2 / 3, value: null } },
          { goalId: 'g_gone', conversion: { visitors: 0, completions: 0, rate: 0, value: null } },
        ],
        rawOnly: true,
      },
      [goal],
    );
    expect(table.header).toEqual([
      'goal_id',
      'goal',
      'converted_visitors',
      'completions',
      'conversion_rate',
      'value',
    ]);
    expect(table.rows).toEqual([
      ['g_1', 'Signed up', 2, 2, 2 / 3, null],
      ['g_gone', '(unknown)', 0, 0, 0, null],
    ]);
  });

  it('a funnel is one row per step, numbered from one, with the step names', () => {
    const funnel: Funnel = {
      siteId: 's',
      id: 'f_1',
      name: 'Checkout',
      window: '1d',
      steps: [
        { kind: 'page', match: '/pricing', name: 'Pricing' },
        { kind: 'event', match: 'signup', name: 'Signed up' },
      ],
      createdBy: 'u',
      createdAt: 0,
    };
    const table = funnelTable(
      {
        visitors: 3,
        steps: [
          { visitors: 2, dropOff: 0, rate: 1, stepRate: null },
          { visitors: 1, dropOff: 1, rate: 0.5, stepRate: 0.5 },
        ],
        rawOnly: true,
      },
      funnel,
    );
    expect(table.header).toEqual(['step', 'name', 'visitors', 'drop_off', 'rate', 'step_rate']);
    expect(table.rows).toEqual([
      [1, 'Pricing', 2, 0, 1, null],
      [2, 'Signed up', 1, 1, 0.5, 0.5],
    ]);
  });

  it('journeys is one row per branch, with Other named', () => {
    const table = journeysTable({
      visits: 3,
      columns: [],
      links: [
        { column: 0, from: '/', to: '/pricing', visits: 2 },
        { column: 1, from: '/pricing', to: null, visits: 1 },
      ],
      branches: 5,
      rawOnly: true,
    });
    expect(table.header).toEqual(['column', 'from', 'to', 'visits']);
    expect(table.rows).toEqual([
      [0, '/', '/pricing', 2],
      [1, '/pricing', '(other)', 1],
    ]);
  });
});

describe('csvOf', () => {
  it('still defuses a key a spreadsheet would run', () => {
    const table = eventsTable({
      visitors: 1,
      rows: [{ key: '=HYPERLINK("x")', visitors: 1, events: 1, rate: 1 }],
      rawOnly: true,
    });
    expect(csvOf(table).split('\r\n')[1]).toBe(`"'=HYPERLINK(""x"")",1,1,1`);
  });
});
