import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TimeChart, type ChartPoint } from './TimeChart.js';

const DHAKA = 'Asia/Dhaka';
const START = Date.UTC(2026, 8, 17, 18, 0, 0);
const HOUR = 60 * 60 * 1000;

function series(values: number[]): ChartPoint[] {
  return values.map((value, index) => ({ start: START + index * HOUR, value }));
}

describe('TimeChart', () => {
  it('draws one line for one series', () => {
    const { container } = render(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([4, 9, 6, 12])}
        interval="hour"
        timezone={DHAKA}
      />,
    );
    expect(container.querySelectorAll('[class*="line"]')).toHaveLength(1);
    expect(container.querySelector('[class*="previous"]')).toBeNull();
  });

  // The title above has already said what the line is, so a legend for one
  // series is a row of text that says it twice.
  it('has no legend with one series and a two entry one with two', () => {
    const { rerender, container } = render(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([4, 9, 6, 12])}
        interval="hour"
        timezone={DHAKA}
      />,
    );
    expect(container.querySelector('[class*="legend"]')).toBeNull();

    rerender(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([4, 9, 6, 12])}
        previous={series([3, 7, 5, 9])}
        interval="hour"
        timezone={DHAKA}
      />,
    );
    expect(container.querySelector('[class*="legend"]')).not.toBeNull();
    expect(screen.getAllByText('Previous period').length).toBeGreaterThan(0);
  });

  // A flat line at zero is a measurement. "We have no rows for this range" is
  // not one, and drawing them the same way is the quietest kind of wrong.
  it('draws no line at all for a range with nothing in it', () => {
    const { container } = render(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([0, 0, 0, 0])}
        interval="hour"
        timezone={DHAKA}
      />,
    );
    expect(container.querySelector('[class*="line"]')).toBeNull();
    expect(screen.getByText('No data in this range.')).toBeInTheDocument();
  });

  // A chart with an aria-label is a described picture. A chart with its own
  // table is data.
  it('carries its numbers in a table for anybody who cannot see the line', () => {
    render(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([4, 9])}
        interval="hour"
        timezone={DHAKA}
      />,
    );
    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('4');
    expect(table).toHaveTextContent('9');
    // The site clock, never the browser's: 18:00 UTC is midnight in Dhaka.
    expect(table).toHaveTextContent('00:00');
  });

  it('lists the second series in the table too, under its own name', () => {
    render(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([4, 9])}
        previous={series([2, 3])}
        previousLabel="Mobile from Bangladesh"
        interval="hour"
        timezone={DHAKA}
      />,
    );
    const table = screen.getByRole('table');
    expect(screen.getByRole('columnheader', { name: 'Mobile from Bangladesh' })).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('4');
    expect(rows[1]).toHaveTextContent('2');
    expect(rows[2]).toHaveTextContent('9');
    expect(rows[2]).toHaveTextContent('3');
  });

  it('labels the axis in the site zone and not the reader one', () => {
    render(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([4, 9, 6, 12])}
        interval="hour"
        timezone="UTC"
      />,
    );
    expect(screen.getByRole('table')).toHaveTextContent('18:00');
  });

  it('marks the last bucket of a live range as now rather than as a time', () => {
    render(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([4, 9, 6, 12])}
        interval="hour"
        timezone={DHAKA}
        live
      />,
    );
    expect(screen.getByText('now')).toBeInTheDocument();
  });

  it('says where the peak was', () => {
    render(
      <TimeChart
        title="Visitors"
        metricLabel="Visitors"
        points={series([4, 96, 6, 12])}
        interval="hour"
        timezone={DHAKA}
      />,
    );
    expect(screen.getByText(/Peak 96 at 01:00/)).toBeInTheDocument();
  });

  // A mark lands on the bucket its instant falls in, by the rule the store
  // folds a row into one: a deploy at 20 past the hour sits on that hour's
  // point, and one after the range's end is not drawn at all.
  describe('the marks', () => {
    const marks = [
      { at: START + HOUR + 20 * 60_000, kind: 'Deploy', label: 'v2.3.0' },
      { at: START + 3 * HOUR + 59 * 60_000, kind: 'Note', label: 'Traffic looked odd' },
      { at: START + 4 * HOUR + 1, kind: 'Downtime', label: 'Past the end' },
      { at: START - 1, kind: 'Campaign', label: 'Before the start' },
    ];

    it('draws one guide per bucket that has a mark, inside the range only', () => {
      const { container } = render(
        <TimeChart
          title="Visitors"
          metricLabel="Visitors"
          points={series([4, 9, 6, 12])}
          interval="hour"
          timezone={DHAKA}
          marks={marks}
          rangeEnd={START + 4 * HOUR}
        />,
      );
      const guides = container.querySelectorAll('[class*="markGlyph"]');
      expect(guides).toHaveLength(2);
      // The native tooltip carries the words.
      expect(container.querySelector('title')?.textContent).toBe('Deploy: v2.3.0');
    });

    it('lists the marks it drew for anybody who cannot see a guide, in the site zone', () => {
      render(
        <TimeChart
          title="Visitors"
          metricLabel="Visitors"
          points={series([4, 9, 6, 12])}
          interval="hour"
          timezone={DHAKA}
          marks={marks}
          rangeEnd={START + 4 * HOUR}
        />,
      );
      const items = screen.getAllByRole('listitem').map((item) => item.textContent);
      // 18:00 UTC is midnight in Dhaka, so the deploy an hour and twenty in is 01:20.
      expect(items).toEqual(['18 Sept, 01:20, Deploy: v2.3.0', '18 Sept, 03:59, Note: Traffic looked odd']);
    });

    it('folds two marks in one bucket into one guide and names both', () => {
      const { container } = render(
        <TimeChart
          title="Visitors"
          metricLabel="Visitors"
          points={series([4, 9, 6, 12])}
          interval="hour"
          timezone={DHAKA}
          marks={[
            { at: START + HOUR, kind: 'Deploy', label: 'v2.3.0' },
            { at: START + HOUR + 30 * 60_000, kind: 'Deploy', label: 'v2.3.1' },
          ]}
          rangeEnd={START + 4 * HOUR}
        />,
      );
      expect(container.querySelectorAll('[class*="markGlyph"]')).toHaveLength(1);
      expect(container.querySelector('title')?.textContent).toBe('Deploy: v2.3.0; Deploy: v2.3.1');
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });

    it('draws no mark and no list on a range with none', () => {
      const { container } = render(
        <TimeChart
          title="Visitors"
          metricLabel="Visitors"
          points={series([4, 9, 6, 12])}
          interval="hour"
          timezone={DHAKA}
        />,
      );
      expect(container.querySelectorAll('[class*="markGlyph"]')).toHaveLength(0);
      expect(screen.queryByRole('list')).toBeNull();
    });
  });
});
