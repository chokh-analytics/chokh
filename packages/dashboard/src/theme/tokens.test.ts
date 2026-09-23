import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Every stylesheet in the package, found rather than listed, so a component
// added later is covered without anybody remembering to add it. jsdom replaces
// the global URL with its own, which node:url refuses, so nothing here builds
// a file URL.
const HERE = dirname(fileURLToPath(import.meta.url));

function stylesheets(): { name: string; text: string }[] {
  const roots = ['.', '../app', '../ui', '../pages', '../reports'];
  const files: { name: string; text: string }[] = [];
  for (const root of roots) {
    const dir = resolve(HERE, root);
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.css')) {
        files.push({
          name: join(root, entry),
          text: readFileSync(resolve(dir, entry), 'utf8'),
        });
      }
    }
  }
  return files;
}

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

// Dark is written twice in tokens.css, once for the system's preference and
// once for a person's own choice, and the two are one palette. They drifted:
// the chosen dark lacked --on-accent, --scrim and --shadow-sm, so somebody who
// picked dark read every primary button as white on the light teal, 2.05:1,
// while somebody whose system was dark read it correctly. Only a page audited
// with a primary button on it, the Funnels builder, showed it.
describe('the two declarations of dark', () => {
  function declarations(text: string, selector: string): Map<string, string> {
    const start = text.indexOf(selector);
    expect(start, `${selector} is not in tokens.css`).toBeGreaterThan(-1);
    const body = text.slice(start, text.indexOf('}', start));
    return new Map(
      [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [
        match[1] ?? '',
        (match[2] ?? '').replace(/\s+/g, ' ').trim(),
      ]),
    );
  }

  it('declares the same tokens with the same values, chosen or preferred', () => {
    const text = readFileSync(resolve(HERE, 'tokens.css'), 'utf8');
    const preferred = declarations(text, ":root:not([data-theme='light']) {");
    const chosen = declarations(text, ":root[data-theme='dark'] {");
    expect(preferred.size).toBeGreaterThan(10);
    expect(Object.fromEntries(chosen)).toEqual(Object.fromEntries(preferred));
  });
});

describe('where a colour may be written', () => {
  // Only the token file. A colour written into a component is a colour with
  // one value, and this product has two palettes: the sheet's scrim was the
  // product's ink at forty percent, which in dark mode is a pale wash laid
  // over a dark page rather than a dimming of it.
  it('never lets a component stylesheet write a colour of its own', () => {
    const offenders: string[] = [];
    for (const sheet of stylesheets()) {
      if (sheet.name.endsWith('tokens.css')) {
        continue;
      }
      const written = sheet.text.match(/#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\(/gi) ?? [];
      for (const colour of written) {
        offenders.push(`${sheet.name}: ${colour}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
