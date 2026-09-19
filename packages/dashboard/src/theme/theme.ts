import type { ThemeName } from './tokens.js';

// Light, dark, or whatever the machine says.
//
// The choice lives in localStorage and on <html data-theme>, and a six line
// script in index.html applies it before the first paint, so nobody ever sees a
// white page turn dark. This module is the same rule in TypeScript, for the
// toggle and for the tests.

export type ThemeChoice = ThemeName | 'system';

export const THEME_KEY = 'chokh:theme';
export const THEME_ATTRIBUTE = 'data-theme';

function isChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

// What the person chose, or 'system' when they never did. Storage can throw in
// a private window and can hold anything a previous version wrote, so both are
// answered the same way: by the default.
export function readChoice(storage: Pick<Storage, 'getItem'> | undefined): ThemeChoice {
  try {
    const stored = storage?.getItem(THEME_KEY);
    return isChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function writeChoice(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  choice: ThemeChoice,
): void {
  try {
    if (choice === 'system') {
      storage?.removeItem(THEME_KEY);
      return;
    }
    storage?.setItem(THEME_KEY, choice);
  } catch {
    // A theme nobody can save is still a theme that works for this visit.
  }
}

// Which palette is actually on screen. The toggle needs this rather than the
// choice, because "switch to dark" from 'system' means looking at what the
// system said first.
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ThemeName {
  if (choice === 'system') {
    return prefersDark ? 'dark' : 'light';
  }
  return choice;
}

// A choice of 'system' takes the attribute off entirely rather than writing the
// resolved name, so the media query in tokens.css keeps deciding and a machine
// that switches at sunset follows without a reload.
export function applyChoice(root: HTMLElement, choice: ThemeChoice): void {
  if (choice === 'system') {
    root.removeAttribute(THEME_ATTRIBUTE);
    return;
  }
  root.setAttribute(THEME_ATTRIBUTE, choice);
}

// What the toggle does: light, dark, back to light. 'system' is reachable from
// the account menu and is not in the cycle, because a two state control that
// sometimes has three states is a control nobody trusts.
export function nextChoice(current: ThemeChoice, prefersDark: boolean): ThemeName {
  return resolveTheme(current, prefersDark) === 'dark' ? 'light' : 'dark';
}
