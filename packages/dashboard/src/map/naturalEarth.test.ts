import { geoNaturalEarth1 } from 'd3-geo';
import { describe, expect, it } from 'vitest';

import { naturalEarth1Raw, project } from './naturalEarth.js';
import { WORLD, SHAPES } from './world.generated.js';

// One projection, two implementations, and a test vector between them.
//
// The outlines are projected by d3 at build time and shipped as paths; the dots
// are projected in the browser by the twenty lines beside this file. If those
// two ever disagree, a dot lands in the sea next to the country it belongs to
// and nothing anywhere says so. This is the same discipline the collector and
// sdk-node keep for the identify signature: two copies of one formula, and a
// shared vector asserted in both.

// Five hundred coordinates on a grid, plus the places this product actually
// draws, because a grid can miss a sign error near a meridian.
function samples(): [number, number][] {
  const grid: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon += 18) {
    for (let lat = -84; lat <= 84; lat += 7) {
      grid.push([lon, lat]);
    }
  }
  return [
    ...grid,
    [90.41, 23.81],
    [91.78, 22.36],
    [88.36, 22.57],
    [-122.08, 37.42],
    [-0.09, 51.51],
    [0, 0],
    [180, 0],
    [-180, 0],
    [0, 84],
    [0, -84],
  ];
}

describe('the runtime projection', () => {
  const d3 = geoNaturalEarth1().scale(WORLD.scale).translate(WORLD.translate);

  it('matches d3 to a hundredth of a pixel, everywhere', () => {
    const worst = samples().reduce((most, [lon, lat]) => {
      const mine = project(lon, lat, WORLD);
      const theirs = d3([lon, lat]);
      if (theirs === null) {
        throw new Error(`d3 refused ${lon}, ${lat}`);
      }
      return Math.max(most, Math.abs(mine[0] - theirs[0]), Math.abs(mine[1] - theirs[1]));
    }, 0);
    expect(worst).toBeLessThan(0.01);
  });

  it('puts the equator and the meridian where d3 does', () => {
    const [x, y] = project(0, 0, WORLD);
    expect(x).toBeCloseTo(WORLD.translate[0], 6);
    expect(y).toBeCloseTo(WORLD.translate[1], 6);
  });

  // The raw form is the thing the two share, so it is worth asserting on its
  // own: a scale or a translate can be wrong without it being wrong.
  it('grows east and north the way the projection does', () => {
    expect(naturalEarth1Raw(10, 0)[0]).toBeGreaterThan(naturalEarth1Raw(5, 0)[0]);
    expect(naturalEarth1Raw(0, 10)[1]).toBeGreaterThan(naturalEarth1Raw(0, 5)[1]);
    // And it is symmetric about both, which is the cheapest way to catch a
    // dropped sign in one of the two polynomials.
    expect(naturalEarth1Raw(-30, 0)[0]).toBeCloseTo(-naturalEarth1Raw(30, 0)[0], 12);
    expect(naturalEarth1Raw(0, -30)[1]).toBeCloseTo(-naturalEarth1Raw(0, 30)[1], 12);
  });
});

describe('the generated world', () => {
  it('carries the countries and not the ice', () => {
    expect(SHAPES.length).toBeGreaterThan(150);
    // Antarctica is six kilobytes of coastline that has never had a visitor.
    expect(SHAPES.map((shape) => shape.id)).not.toContain('010');
  });

  it('draws every one of them inside the box it declares', () => {
    for (const shape of SHAPES) {
      expect(shape.d.startsWith('M'), shape.id).toBe(true);
    }
    const numbers = SHAPES.flatMap((shape) =>
      (shape.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number),
    );
    expect(Math.min(...numbers)).toBeGreaterThan(-2);
    expect(Math.max(...numbers)).toBeLessThan(Math.max(WORLD.width, WORLD.height) + 2);
  });
});
