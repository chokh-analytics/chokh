import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SHAPES } from '../map/world.generated.js';
import { bandOf, Choropleth, STEPS } from './Choropleth.js';

// The map that paints countries, and the two ways a choropleth lies.
//
// The first is painting a country nobody came from: an unvisited country in the
// palest band is indistinguishable from one visitor, and the map then says
// somebody was there. The second is a linear scale, which on analytics data
// paints everything in one band because one country almost always has an order
// of magnitude more than the rest.

describe('bandOf', () => {
  it('gives a country with no visitors no band at all', () => {
    expect(bandOf(0, 1000)).toBeNull();
  });

  it('puts the biggest country in the darkest band and one visitor in the lightest', () => {
    expect(bandOf(1000, 1000)).toBe(STEPS - 1);
    expect(bandOf(1, 1000)).toBe(0);
  });

  // The point of the log scale: on 1, 10, 100, 1000 a linear ramp puts the
  // first three in one band, which is a map of one country.
  it('spreads an order of magnitude spread across the bands', () => {
    const bands = [1, 10, 100, 1000].map((value) => bandOf(value, 1000));
    expect(new Set(bands).size).toBe(4);
  });

  it('never returns a band outside the ramp', () => {
    for (const value of [1, 3, 17, 240, 999, 1000]) {
      const band = bandOf(value, 1000) ?? 0;
      expect(band).toBeGreaterThanOrEqual(0);
      expect(band).toBeLessThan(STEPS);
    }
  });
});

describe('Choropleth', () => {
  it('joins on the two letter code the store files a country under', () => {
    // The generated outlines are keyed by alpha-2, which is what makes the join
    // possible at all: a numeric key would need a translation table nobody
    // maintains.
    expect(SHAPES.map((shape) => shape.id)).toContain('BD');
    expect(SHAPES.map((shape) => shape.id)).toContain('US');
  });

  it('carries the same numbers as a list for anybody who cannot see it', () => {
    render(
      <Choropleth
        countries={[
          { key: 'BD', visitors: 900 },
          { key: 'GB', visitors: 12 },
        ]}
      />,
    );
    expect(screen.getByText('Bangladesh: 900')).toBeInTheDocument();
    expect(screen.getByText('United Kingdom: 12')).toBeInTheDocument();
  });

  it('paints only the countries that were visited', () => {
    const { container } = render(<Choropleth countries={[{ key: 'BD', visitors: 900 }]} />);
    const painted = container.querySelectorAll('path:not([class*="empty"])');
    expect(painted).toHaveLength(1);
  });
});
