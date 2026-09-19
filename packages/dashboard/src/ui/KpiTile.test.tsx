import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { delta, deltaPoints, GOOD_WHEN } from '../lib/format.js';
import { KpiTile, LiveValue } from './KpiTile.js';

// The tile is where two of this product's rules are kept or broken: a number
// that could not be computed must not be drawn as a zero, and a comparison
// against an empty previous window must say it has no baseline rather than
// saying nothing changed.

describe('KpiTile', () => {
  it('shows the number and its movement', () => {
    render(
      <KpiTile label="Visitors" value="1,284" delta={delta(1284, 1146, GOOD_WHEN.visitors)} />,
    );
    expect(screen.getByText('1,284')).toBeInTheDocument();
    expect(screen.getByText(/12%/)).toBeInTheDocument();
  });

  // "No change" is a claim. A previous window with nothing in it supports none.
  it('says there is no baseline rather than saying nothing changed', () => {
    render(<KpiTile label="Visitors" value="1,284" delta={delta(1284, 0)} />);
    expect(screen.getByText('no baseline')).toBeInTheDocument();
    expect(screen.queryByText('no change')).toBeNull();
  });

  it('keeps nothing changed apart from nothing to compare', () => {
    render(<KpiTile label="Visitors" value="100" delta={delta(100, 100)} />);
    expect(screen.getByText('no change')).toBeInTheDocument();
  });

  // A bounce rate the store could not compute is not zero percent, which would
  // read as a perfect score.
  it('never draws a number the store could not compute as a zero', () => {
    render(<KpiTile label="Bounce rate" value={null} />);
    expect(screen.getByText('not available')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });

  // The one metric whose rise is bad. Everything else uses the same colour rule
  // in the other direction, which is why it is a table and not an if.
  it('colours a rise in the bounce rate as a bad one', () => {
    const { container } = render(
      <KpiTile
        label="Bounce rate"
        value="41%"
        delta={deltaPoints(0.41, 0.38, GOOD_WHEN.bounceRate)}
      />,
    );
    const moved = screen.getByText(/3 pts/);
    expect(moved.className).toMatch(/bad/);
    expect(container.querySelector('[class*="good"]')).toBeNull();
  });

  it('colours a rise in visitors as a good one', () => {
    render(<KpiTile label="Visitors" value="120" delta={delta(120, 100, GOOD_WHEN.visitors)} />);
    expect(screen.getByText(/20%/).className).toMatch(/good/);
  });

  // Online now is neither better nor worse for being higher.
  it('leaves a metric with no opinion in the neutral colour', () => {
    render(<KpiTile label="Online now" value="37" delta={delta(37, 20, GOOD_WHEN.onlineNow)} />);
    const moved = screen.getByText(/85%/);
    expect(moved.className).not.toMatch(/good|bad/);
  });

  it('is a button only when pressing it does something', async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<KpiTile label="Visitors" value="12" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: /Visitors/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);

    rerender(<KpiTile label="Visitors" value="12" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says which tile the chart is following', () => {
    render(<KpiTile label="Pageviews" value="12" onSelect={() => {}} selected />);
    expect(screen.getByRole('button', { name: /Pageviews/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows the label before the number while it is loading', () => {
    render(<KpiTile label="Visitors" value={null} loading />);
    expect(screen.getByText('Visitors')).toBeInTheDocument();
    expect(screen.queryByText('not available')).toBeNull();
  });
});

// The one number on the page that changes while nobody touches anything.
describe('LiveValue', () => {
  it('announces a change nobody can see', () => {
    render(<LiveValue count={37} note="12 signed in, 25 anonymous" />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('37 online now');
    // Polite, so it waits for a gap rather than cutting across whatever is
    // being read.
    expect(region.getAttribute('aria-live')).toBe('polite');
    // Off screen, because the figure it is announcing is already on it.
    expect(region.className).toBe('sr-only');
  });
});
