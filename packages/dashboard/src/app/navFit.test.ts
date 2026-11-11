import { describe, expect, it } from 'vitest';

import { fitNav } from './navFit.js';

// AN-DSH03: what fits in the bar's row, and what goes under More. Eleven
// destinations of 70 px with a 4 px gap are 810 px; More is 64 px.
const WIDTHS = new Array<number>(11).fill(70);
const GAP = 4;
const MORE = 64;

describe('fitNav', () => {
  it('puts every destination in the row when they all fit, and draws no More', () => {
    expect(fitNav(WIDTHS, 810, MORE, GAP, 3)).toEqual({ shown: 11, more: false, currentInMore: false });
    expect(fitNav(WIDTHS, 1200, MORE, GAP, 10)).toEqual({ shown: 11, more: false, currentInMore: false });
  });

  it('keeps as many as fit beside More, in order, and puts the rest under it', () => {
    // 64 + 6 * (4 + 70) = 508, and a seventh would be 582.
    expect(fitNav(WIDTHS, 560, MORE, GAP, 0)).toEqual({ shown: 6, more: true, currentInMore: false });
    // One pixel short of all eleven: More takes the last one's place.
    expect(fitNav(WIDTHS, 809, MORE, GAP, 0).shown).toBe(10);
  });

  it('says when the page somebody is on is under More, so the trigger carries its mark', () => {
    expect(fitNav(WIDTHS, 560, MORE, GAP, 9)).toMatchObject({ shown: 6, currentInMore: true });
    expect(fitNav(WIDTHS, 560, MORE, GAP, 5)).toMatchObject({ currentInMore: false });
    // On a page that is none of the destinations (Settings), nothing is current.
    expect(fitNav(WIDTHS, 560, MORE, GAP, -1)).toMatchObject({ currentInMore: false });
  });

  it('follows a resize both ways', () => {
    const wide = fitNav(WIDTHS, 900, MORE, GAP, 8);
    const narrow = fitNav(WIDTHS, 400, MORE, GAP, 8);
    const back = fitNav(WIDTHS, 900, MORE, GAP, 8);
    expect(wide.more).toBe(false);
    expect(narrow).toEqual({ shown: 4, more: true, currentInMore: true });
    expect(back).toEqual(wide);
  });

  it('draws everything before anything is measured, and only More when nothing fits', () => {
    expect(fitNav(WIDTHS, 0, MORE, GAP, 2).shown).toBe(11);
    expect(fitNav(WIDTHS, 100, MORE, GAP, 2)).toEqual({ shown: 0, more: true, currentInMore: true });
  });
});
