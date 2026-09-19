import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WORLD } from '../map/world.generated.js';
import { placeCities, WorldMap } from './WorldMap.js';

// Where the dots go, and what happens when two of them land on each other.
//
// A dot underneath another dot cannot be hovered and its city cannot be read,
// so two towns twenty kilometres apart have to become one dot with the sum in
// it rather than one dot with half the people hidden behind it. The list beside
// the map is the same data for anybody who cannot see the dots, so it is
// asserted on the same fixture.

const DHAKA = { key: 'Dhaka', country: 'BD', lat: 23.81, lon: 90.41, visitors: 3 };
const NARAYANGANJ = { key: 'Narayanganj', country: 'BD', lat: 23.62, lon: 90.5, visitors: 2 };
const LONDON = { key: 'London', country: 'GB', lat: 51.51, lon: -0.13, visitors: 1 };

describe('placeCities', () => {
  it('puts a northern city above a southern one and an eastern city to the right', () => {
    const [dhaka, london] = placeCities([DHAKA, LONDON], WORLD.width);
    expect(dhaka?.city.key).toBe('Dhaka');
    expect(london?.city.key).toBe('London');
    expect((london?.y ?? 0) < (dhaka?.y ?? 0)).toBe(true);
    expect((dhaka?.x ?? 0) > (london?.x ?? 0)).toBe(true);
  });

  it('merges cities that would overlap, and keeps everybody in the count', () => {
    const placed = placeCities([DHAKA, NARAYANGANJ, LONDON], WORLD.width);
    expect(placed).toHaveLength(2);
    const merged = placed.find((dot) => dot.city.key === 'Dhaka');
    expect(merged?.city.visitors).toBe(5);
  });

  // Area, not radius: ten people in one city must not be ten times the ink of
  // one, or one busy city covers a continent.
  it('grows a dot by area rather than by radius', () => {
    const [one] = placeCities([{ ...LONDON, visitors: 1 }], WORLD.width);
    const [hundred] = placeCities([{ ...LONDON, visitors: 100 }], WORLD.width);
    expect((hundred?.radius ?? 0) / (one?.radius ?? 1)).toBeLessThan(10);
    expect((hundred?.radius ?? 0) > (one?.radius ?? 0)).toBe(true);
  });

  // A presence entry without coordinates is a city the geo database did not
  // place. Drawing it at zero, zero puts it in the Gulf of Guinea.
  it('leaves out a city with no coordinates rather than placing it at zero', () => {
    const placed = placeCities([{ key: 'Nowhere', visitors: 9 }, LONDON], WORLD.width);
    expect(placed.map((dot) => dot.city.key)).toEqual(['London']);
  });
});

describe('WorldMap', () => {
  it('carries the same cities as a list for anybody who cannot see the dots', () => {
    render(<WorldMap cities={[DHAKA, LONDON]} />);
    expect(screen.getByText(/Dhaka, Bangladesh: 3/)).toBeInTheDocument();
    expect(screen.getByText(/London, United Kingdom: 1/)).toBeInTheDocument();
  });
});
