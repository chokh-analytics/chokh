import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Breakdown, type BreakdownRowView } from './Breakdown.js';

// The row every report is made of, and the rule this product keeps everywhere:
// a row that can filter is a button, a row that cannot is text with no hover.
// A control that looks pressable and does nothing is worse than one that does
// not look pressable at all.

function rows(over: Partial<BreakdownRowView>[] = []): BreakdownRowView[] {
  const base: BreakdownRowView[] = [
    { key: '/pricing', label: '/pricing', value: '412', share: 1 },
    { key: '/docs', label: '/docs', value: '298', share: 0.72 },
  ];
  return base.map((row, index) => ({ ...row, ...over[index] }));
}

describe('Breakdown', () => {
  it('renders a real table, so a screen reader gets a table', () => {
    render(<Breakdown rows={rows()} dimensionLabel="Page" valueLabel="Visitors" caption="Top pages" />);
    expect(screen.getByRole('table', { name: 'Top pages' })).toBeInTheDocument();
    // Two rows of data and the head above them.
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  // A card says its column names in its own header, so drawing them again above
  // the rows is chrome. Leaving them out of the markup is a different thing: a
  // screen reader then reads a column of numbers with nothing to call them.
  it('names its columns to a screen reader even where it draws no head', () => {
    render(<Breakdown rows={rows()} dimensionLabel="Page" valueLabel="Visitors" caption="Top pages" />);
    expect(screen.getByRole('columnheader', { name: 'Page' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Visitors' })).toBeInTheDocument();
  });

  it('scales each bar against the biggest row on the card', () => {
    const { container } = render(
      <Breakdown rows={rows()} dimensionLabel="Page" valueLabel="Visitors" caption="Top pages" />,
    );
    const bars = container.querySelectorAll('[class*="bar"]');
    expect((bars[0] as HTMLElement).style.width).toBe('100%');
    expect((bars[1] as HTMLElement).style.width).toBe('72%');
  });

  it('clicks through to whatever the row was told to do', async () => {
    const onClick = vi.fn();
    render(
      <Breakdown
        rows={rows([{ onClick }])}
        dimensionLabel="Page"
        valueLabel="Visitors"
        caption="Top pages"
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /pricing/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Entry, exit and channel: the store refuses a filter naming one, so the row
  // is never offered as a thing to press.
  it('is not a button when the dimension cannot be filtered', () => {
    render(
      <Breakdown rows={rows()} dimensionLabel="Entry page" valueLabel="Visitors" caption="Entry pages" />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('/pricing')).toBeInTheDocument();
  });

  // A blank row looks like a bug in the report. This one is a fact about the
  // data: the browser sent nothing for that dimension.
  it('names a value the browser never sent rather than leaving it blank', () => {
    render(
      <Breakdown
        rows={[{ key: '', label: '', value: '12', share: 1, unknown: true }]}
        dimensionLabel="Referrer"
        valueLabel="Visitors"
        caption="Referrers"
      />,
    );
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('carries the exact number for a label that was compacted', () => {
    render(
      <Breakdown
        rows={[{ key: '/a', label: '/a', value: '12.8K', title: '12,834', share: 1 }]}
        dimensionLabel="Page"
        valueLabel="Visitors"
        caption="Top pages"
      />,
    );
    expect(screen.getByTitle('12,834')).toHaveTextContent('12.8K');
  });

  it('draws that head only on a full report', () => {
    const { container, rerender } = render(
      <Breakdown rows={rows()} dimensionLabel="Page" valueLabel="Visitors" caption="Top pages" />,
    );
    expect(container.querySelector('thead')?.className).toBe('sr-only');

    rerender(
      <Breakdown
        rows={rows()}
        dimensionLabel="Page"
        valueLabel="Visitors"
        caption="Top pages"
        showHead
      />,
    );
    expect(container.querySelector('thead')?.className).not.toBe('sr-only');
  });
});
