import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHART_HEIGHT, TimeChart, tickIndexes, type ChartPoint } from './TimeChart.js';

// How big the drawing is, which is a different question from what it draws.
//
// A viewBox with preserveAspectRatio="none" and height:auto scales the whole
// drawing like an image: on a 360px phone the 190 unit box became 95px tall and
// the axis text was about five pixels, and on a wide screen it grew by half
// again. What the box is worth measuring for is that one unit is one CSS pixel
// at every width, which is what these assert.

const DHAKA = 'Asia/Dhaka';
const START = Date.UTC(2026, 8, 17, 18, 0, 0);

function series(values: number[]): ChartPoint[] {
  return values.map((value, index) => ({ start: START + index * 3_600_000, value }));
}

// jsdom has no ResizeObserver, so the component falls back to its default
// width. This one reports whatever the test says the box is.
function observeAt(width: number): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly onResize: ResizeObserverCallback) {}
      observe(): void {
        this.onResize(
          [{ contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

function chart(): SVGSVGElement {
  return screen.getByRole('img') as unknown as SVGSVGElement;
}

function draw(): void {
  render(
    <TimeChart
      title="Visitors"
      metricLabel="Visitors"
      points={series([4, 9, 6, 12])}
      interval="hour"
      timezone={DHAKA}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the size of the drawing', () => {
  it('is the same height whatever the box is', () => {
    observeAt(1180);
    draw();
    expect(chart().getAttribute('height')).toBe(String(CHART_HEIGHT));
  });

  it('is still that height on a phone', () => {
    observeAt(358);
    draw();
    expect(chart().getAttribute('height')).toBe(String(CHART_HEIGHT));
  });

  // The whole point: a viewBox that matches the box in both directions means an
  // SVG unit is a CSS pixel, so a 10px tick is 10px on a phone and on a
  // monitor. A viewBox wider or narrower than the element is a scale factor.
  it('keeps one unit to one pixel by measuring, not by stretching', () => {
    observeAt(358);
    draw();
    expect(chart().getAttribute('viewBox')).toBe(`0 0 358 ${CHART_HEIGHT}`);
    expect(chart().getAttribute('preserveAspectRatio')).toBeNull();
  });

  it('redraws at the width it was told about', () => {
    observeAt(900);
    draw();
    expect(chart().getAttribute('viewBox')).toBe(`0 0 900 ${CHART_HEIGHT}`);
  });

  it('draws at a usable default where nothing can measure it', () => {
    draw();
    expect(chart().getAttribute('viewBox')).toBe(`0 0 720 ${CHART_HEIGHT}`);
  });
});

// Two layout rules that only a stylesheet can express, asserted against the
// stylesheet. Both are rules about what must never happen rather than about a
// number, and both came back once already: an orphan card on its own row, and a
// header that spills its controls onto a third line.
function css(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

// Five dates at a readable size want about ninety pixels each, so making the
// text legible on a phone and then drawing five of it is the same problem
// again.
describe('how many labels the axis holds', () => {
  it('drops to three where five would run into each other', () => {
    expect(tickIndexes(30, 390)).toHaveLength(3);
    expect(tickIndexes(30, 1180)).toHaveLength(5);
  });

  it('always keeps the first and the last', () => {
    for (const width of [390, 1180]) {
      const ticks = tickIndexes(30, width);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(29);
    }
  });

  it('never invents a label for a bucket that is not there', () => {
    expect(tickIndexes(2, 390)).toEqual([0, 1]);
    expect(tickIndexes(1, 390)).toEqual([0]);
    expect(tickIndexes(0, 390)).toEqual([]);
  });
});

describe('the rules a stylesheet keeps', () => {
  it('never lets the card grid choose its own column count', () => {
    const rules = css('../pages/Overview.module.css');
    // auto-fit is what produced three cards and an orphan at 1440: 1232px of
    // content fits three 300px columns and misses four by eight pixels.
    expect(rules).not.toMatch(/\.cards[^}]*auto-fit/s);
    expect(rules).toMatch(/\.cards\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
    const wide = rules.slice(rules.indexOf('@media (min-width: 1200px)'));
    expect(wide).toMatch(/repeat\(4, minmax\(0, 1fr\)\)/);
  });

  it('gives the phone range bar two rows and not three', () => {
    const rules = css('../app/RangeBar.module.css');
    const phone = rules.slice(rules.indexOf('@media (max-width: 720px)'));
    // The full width note was what pushed itself onto a row of its own.
    expect(rules).not.toMatch(/@media \(max-width: 640px\)[^}]*\}[^}]*width: 100%/s);
    expect(phone).toMatch(/\.spacer\s*\{\s*display: none;/);
    expect(phone).toMatch(/\.zone\s*\{[^}]*margin-left: auto/s);
    // The preamble goes with it: the row already says which window is on screen.
    expect(phone).toMatch(/\.zoneLong\s*\{\s*display: none;/);
  });

  it('gives the phone header two rows and not three', () => {
    const rules = css('../app/Shell.module.css');
    const phone = rules.slice(rules.indexOf('@media (max-width: 720px)'));
    // The flexible spacer took the space before the tools could wrap with the
    // switcher, so the toggle and the account landed on a row of their own.
    expect(phone).toMatch(/\.spacer\s*\{\s*display: none;/);
    expect(phone).toMatch(/\.tools\s*\{\s*margin-left: auto;/);
    expect(phone).toMatch(/\.nav\s*\{[^}]*width: 100%/s);
  });
});
