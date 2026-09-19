import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The motion budget, kept by a test because it is the kind of rule that decays
// one component at a time.
//
// Two kinds of movement exist here and they are held to different rules.
//
// A response to something a person did, which is every transition and every
// animation that runs once, takes 120ms or 180ms and nothing else: those are
// the two tokens, and a component that writes its own figure has invented a
// third speed for the same product. A dashboard is read in glances, and an
// animation long enough to notice is an animation somebody waits for.
//
// A loop that runs on its own, which is the live dot, the splash thread and the
// skeleton shimmer, sets its own period, because its job is to say "still
// going" rather than to answer anything. It has one rule instead: slow enough
// not to read as an alarm, and a one second floor is where a pulse stops
// feeling urgent.
//
// Nothing travels further than eight pixels, because a panel that crosses the
// screen is a thing arriving from somewhere and nothing here comes from
// anywhere. All of it is off under prefers-reduced-motion, which is one rule in
// base.css rather than a media query per component, because the per-component
// version is the one a new component forgets.

// The directory this file is in, resolved once. jsdom replaces the global URL
// with its own, which node:url refuses, so nothing here builds a file URL.
const HERE = dirname(fileURLToPath(import.meta.url));

function read(path: string): string {
  return readFileSync(resolve(HERE, path), 'utf8');
}

// Every stylesheet in the package, so a component added later is covered by
// these rules without anybody adding it to a list.
function stylesheets(): { name: string; text: string }[] {
  const roots = ['.', '../app', '../ui', '../pages', '../reports'];
  const files: { name: string; text: string }[] = [];
  for (const root of roots) {
    const dir = resolve(HERE, root);
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.css')) {
        files.push({ name: join(root, entry), text: read(join(root, entry)) });
      }
    }
  }
  return files;
}

function seconds(value: string): number {
  const amount = Number(value.replace(/m?s$/, ''));
  return value.endsWith('ms') ? amount / 1000 : amount;
}

describe('the motion budget', () => {
  it('turns everything off for anybody who asked for less of it', () => {
    const base = read('base.css');
    expect(base).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const rule = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rule).toMatch(/animation-duration: 0\.01ms !important/);
    expect(rule).toMatch(/transition-duration: 0\.01ms !important/);
  });

  it('keeps its two response speeds in the token file', () => {
    const tokens = read('tokens.css');
    expect(tokens).toMatch(/--fast: 120ms/);
    expect(tokens).toMatch(/--slow: 180ms/);
  });

  it('never lets a transition invent its own speed', () => {
    for (const sheet of stylesheets()) {
      for (const found of sheet.text.match(/transition:[^;]+;/g) ?? []) {
        expect(
          /var\(--fast\)|var\(--slow\)/.test(found),
          `${sheet.name} writes a transition speed of its own: ${found.trim()}`,
        ).toBe(true);
      }
    }
  });

  it('never lets an animation that runs once invent its own speed', () => {
    for (const sheet of stylesheets()) {
      const once = (sheet.text.match(/animation:[^;]+;/g) ?? []).filter(
        // "animation: none" is a component turning one off, which every
        // reduced-motion block and every idle state does.
        (rule) => !rule.includes('infinite') && !rule.includes('none'),
      );
      for (const found of once) {
        expect(
          /var\(--fast\)|var\(--slow\)/.test(found),
          `${sheet.name} writes an animation speed of its own: ${found.trim()}`,
        ).toBe(true);
      }
    }
  });

  // Six declarations and three shapes: the live dot's pulse, which three
  // screens draw, the sweep the splash and the skeleton share, and the
  // skeleton's own slide. Counting the declarations makes a seventh thing that
  // moves on its own a decision somebody takes rather than one that arrives
  // with a component.
  it('keeps every loop slow enough not to read as an alarm', () => {
    const loops: string[] = [];
    for (const sheet of stylesheets()) {
      const running = (sheet.text.match(/animation:[^;]+;/g) ?? []).filter((rule) =>
        rule.includes('infinite'),
      );
      for (const rule of running) {
        const period = rule.match(/\d+(?:\.\d+)?m?s/)?.[0];
        expect(period, `${sheet.name} loops with no period: ${rule.trim()}`).toBeDefined();
        expect(
          seconds(period ?? '0s'),
          `${sheet.name} loops every ${period ?? '?'}`,
        ).toBeGreaterThanOrEqual(1);
        loops.push(sheet.name);
      }
    }
    expect(loops).toHaveLength(6);
  });

  it('never moves anything further than eight pixels', () => {
    for (const sheet of stylesheets()) {
      for (const travel of sheet.text.match(/translate[XY]?\(([^)]*)\)/g) ?? []) {
        const pixels = [...travel.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) =>
          Math.abs(Number(match[1])),
        );
        for (const distance of pixels) {
          expect(distance, `${sheet.name} moves ${distance}px`).toBeLessThanOrEqual(8);
        }
      }
    }
  });
});
