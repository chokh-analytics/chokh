// The design system as data, so the contrast test can read the same numbers the
// stylesheet does.
//
// tokens.css is the file the browser reads and this file is the file the tests
// read. They are two spellings of one table, and the test at the bottom of this
// package's theme folder asserts that every pair a person is ever asked to read
// clears WCAG AA in both themes. A colour that only looks fine on the designer's
// monitor is how a dashboard scores 94 on accessibility and nobody knows why.

export interface Palette {
  ground: string;
  paper: string;
  soft: string;
  line: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  live: string;
  liveSoft: string;
  dead: string;
  deadSoft: string;
  warn: string;
  warnSoft: string;
}

// Light and dark are the same system declared twice, never two drawings. Every
// token exists in both, so a component never asks which theme it is in.
export const LIGHT: Palette = {
  ground: '#F6F7F4',
  paper: '#FFFFFF',
  soft: '#EEF2EF',
  line: '#D8DFDC',
  ink: '#17222B',
  muted: '#55656E',
  accent: '#0E7C73',
  accentInk: '#0A5C55',
  accentSoft: '#DDF0EC',
  live: '#1B7A36',
  liveSoft: '#DDF2E1',
  dead: '#A93D18',
  deadSoft: '#F8E4DA',
  warn: '#7A5400',
  warnSoft: '#F8EFCF',
};

export const DARK: Palette = {
  ground: '#0E1417',
  paper: '#141C20',
  soft: '#1B2529',
  line: '#2A363C',
  ink: '#E4EAE7',
  muted: '#9AA8AE',
  accent: '#3BC9B8',
  accentInk: '#7FE0D3',
  accentSoft: '#12312F',
  live: '#5BCF7A',
  liveSoft: '#15301D',
  dead: '#F0855A',
  deadSoft: '#3A2018',
  warn: '#E5B54A',
  warnSoft: '#3A2E10',
};

export const PALETTES = { light: LIGHT, dark: DARK } as const;

export type ThemeName = keyof typeof PALETTES;

// Every foreground and background a person is actually asked to read, with the
// size class that decides which threshold applies. WCAG calls 18.66px at 600 or
// 24px at any weight "large", and everything in this list that is large says so.
export interface ContrastPair {
  where: string;
  foreground: keyof Palette;
  background: keyof Palette;
  large?: boolean;
}

export const CONTRAST_PAIRS: ContrastPair[] = [
  { where: 'body text on the page', foreground: 'ink', background: 'ground' },
  { where: 'body text on a card', foreground: 'ink', background: 'paper' },
  { where: 'body text on a table head', foreground: 'ink', background: 'soft' },
  { where: 'a label on the page', foreground: 'muted', background: 'ground' },
  { where: 'a label on a card', foreground: 'muted', background: 'paper' },
  { where: 'a column head on a table head', foreground: 'muted', background: 'soft' },
  { where: 'a link on the page', foreground: 'accentInk', background: 'ground' },
  { where: 'a link on a card', foreground: 'accentInk', background: 'paper' },
  { where: 'a chip label on its tint', foreground: 'accentInk', background: 'accentSoft' },
  { where: 'a row label over its bar', foreground: 'ink', background: 'accentSoft' },
  { where: 'a KPI value on a card', foreground: 'ink', background: 'paper', large: true },
  { where: 'a rise on a card', foreground: 'live', background: 'paper' },
  { where: 'a fall on a card', foreground: 'dead', background: 'paper' },
  { where: 'a caveat on a card', foreground: 'warn', background: 'paper' },
  { where: 'a live pill on its tint', foreground: 'live', background: 'liveSoft' },
  { where: 'an error pill on its tint', foreground: 'dead', background: 'deadSoft' },
  { where: 'a warning pill on its tint', foreground: 'warn', background: 'warnSoft' },
];

// The threshold a pair has to clear. 3:1 for large text, 4.5:1 for the rest,
// which is AA. AAA is not the target: a dashboard read for eight hours wants
// contrast that is comfortable rather than maximal, and 7:1 pushes every muted
// label back to near black.
export function thresholdFor(pair: ContrastPair): number {
  return pair.large === true ? 3 : 4.5;
}

function channel(value: number): number {
  const fraction = value / 255;
  return fraction <= 0.03928 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) {
    throw new Error(`Not a six digit hex colour: ${hex}`);
  }
  const int = Number.parseInt(match[1] as string, 16);
  const red = channel((int >> 16) & 0xff);
  const green = channel((int >> 8) & 0xff);
  const blue = channel(int & 0xff);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

// WCAG 2.1 contrast ratio, between 1 and 21.
export function contrastRatio(left: string, right: string): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
