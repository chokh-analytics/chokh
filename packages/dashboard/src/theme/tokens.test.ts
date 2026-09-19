import { describe, expect, it } from 'vitest';

import {
  CONTRAST_PAIRS,
  DARK,
  LIGHT,
  PALETTES,
  contrastRatio,
  thresholdFor,
  type Palette,
} from './tokens.js';

// The cheap test that keeps the Lighthouse gate from being a fire drill.
//
// A colour contrast failure is found either here, in a second, against a table,
// or in CI at the end of a build against a rendered page that says 0.94 and
// leaves you guessing which of forty elements it meant. This is the same
// arithmetic Lighthouse runs, on the pairs the design actually uses.

describe('colour tokens', () => {
  it.each(Object.entries(PALETTES))('%s clears AA on every pair a person reads', (name, palette) => {
    const failures = CONTRAST_PAIRS.filter((pair) => {
      const ratio = contrastRatio(palette[pair.foreground], palette[pair.background]);
      return ratio < thresholdFor(pair);
    }).map((pair) => {
      const ratio = contrastRatio(palette[pair.foreground], palette[pair.background]);
      return `${name}: ${pair.where} is ${ratio.toFixed(2)}:1, needs ${thresholdFor(pair)}:1`;
    });
    expect(failures).toEqual([]);
  });

  // Both themes declare the same system. A token that exists in one and not the
  // other is a component that has to ask which theme it is in.
  it('declares every token in both themes', () => {
    expect(Object.keys(LIGHT).sort()).toEqual(Object.keys(DARK).sort());
  });

  it('writes every colour as a six digit hex, which is what the ratio reads', () => {
    for (const palette of Object.values(PALETTES)) {
      for (const [token, value] of Object.entries(palette as Palette)) {
        expect(value, token).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  // A known answer, so a mistake in the ratio itself cannot make the table above
  // pass by being wrong in both directions.
  it('agrees with the WCAG worked examples', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
});
