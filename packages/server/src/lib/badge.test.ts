import { describe, expect, it } from 'vitest';

import { badgeSvg, compactCount } from './badge.js';

describe('compactCount', () => {
  it('groups below ten thousand and compacts above it', () => {
    expect(compactCount(0)).toBe('0');
    expect(compactCount(9_999)).toBe('9,999');
    expect(compactCount(12_345)).toBe('12.3K');
    expect(compactCount(2_400_000)).toBe('2.4M');
    expect(compactCount(Number.NaN)).toBe('0');
  });
});

describe('badgeSvg', () => {
  it('is an SVG named for a reader, sized from its text, with the text escaped', () => {
    const svg = badgeSvg('Visitors, 30 days', '12.3K');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<title>Visitors, 30 days: 12.3K</title>');
    expect(svg).toContain('aria-label="Visitors, 30 days: 12.3K"');
    expect(svg).toContain('>12.3K</text>');
    const width = Number(/width="(\d+)"/.exec(svg)?.[1]);
    expect(width).toBeGreaterThan(120);
    expect(badgeSvg('<b>&"', '1')).toContain('&lt;b&gt;&amp;&quot;');
  });
});
