import { describe, expect, it } from 'vitest';

import {
  COMPACT_FROM,
  languageName,
  delta,
  deltaPoints,
  countryName,
  formatClock,
  formatCount,
  formatDuration,
  formatExact,
  formatOnlineFor,
  formatRate,
  formatRatio,
  formatSince,
  viewsPerVisit,
  GOOD_WHEN,
} from './format.js';

const DHAKA = 'Asia/Dhaka';

describe('formatCount', () => {
  it('writes a small number out in full, because rounding it away loses the point', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(7)).toBe('7');
    expect(formatCount(1_284)).toBe('1,284');
    expect(formatCount(COMPACT_FROM - 1)).toBe('9,999');
  });

  it('compacts from ten thousand up, where the last three digits are noise', () => {
    expect(formatCount(COMPACT_FROM)).toBe('10K');
    expect(formatCount(12_800)).toBe('12.8K');
    expect(formatCount(1_240_000)).toBe('1.2M');
  });

  it('always has the exact number to fall back on', () => {
    expect(formatExact(1_240_000)).toBe('1,240,000');
  });
});

describe('formatRate', () => {
  // The bug this function exists for. Chokh answers bounces over visits as a
  // fraction; a page shows a percentage. One multiplication, in one place.
  it('turns the fraction the API sends into the percentage a page shows', () => {
    expect(formatRate(0.41)).toBe('41%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(0.5)).toBe('50%');
  });

  it('keeps a decimal below ten percent, where the decimal is the story', () => {
    expect(formatRate(0.042)).toBe('4.2%');
    expect(formatRate(0.048)).toBe('4.8%');
    expect(formatRate(0.0999)).toBe('10%');
    // A trailing zero says only that a division happened somewhere.
    expect(formatRate(0.08)).toBe('8%');
  });

  // A rate over no visits is unknown, not zero. Rendering it as 0% is a number
  // where there is none, and it reads as a perfect score.
  it('answers null for a rate the store could not compute', () => {
    expect(formatRate(null)).toBeNull();
    expect(formatRate(undefined)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('says a duration the way somebody says it out loud', () => {
    expect(formatDuration(48_000)).toBe('48s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
  });

  it('never shows a decimal', () => {
    expect(formatDuration(192_400)).toBe('3m 12s');
  });

  it('answers null for a duration nobody measured', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});

describe('delta', () => {
  it('names the direction and the size', () => {
    expect(delta(112, 100)).toMatchObject({ kind: 'up', label: '12%' });
    expect(delta(92, 100)).toMatchObject({ kind: 'down', label: '8%' });
    expect(delta(104.2, 100)).toMatchObject({ kind: 'up', label: '4.2%' });
  });

  // The second bug this file exists for. A previous window with nothing in it
  // has no percentage; answering zero renders "no change", which is a claim.
  it('has no answer at all when there is no baseline', () => {
    expect(delta(50, 0)).toMatchObject({ kind: 'none', label: null });
    expect(delta(50, null)).toMatchObject({ kind: 'none', label: null });
    expect(delta(50, undefined)).toMatchObject({ kind: 'none', label: null });
  });

  it('keeps "nothing moved" apart from "there is nothing to compare"', () => {
    expect(delta(100, 100).kind).toBe('flat');
    expect(delta(100, 0).kind).toBe('none');
  });

  // Only bounce rate is inverted, and it is the one that would otherwise be
  // drawn green while getting worse.
  it('colours a movement by what the metric wants, not by its sign', () => {
    expect(delta(112, 100, GOOD_WHEN.visitors).tone).toBe('good');
    expect(delta(92, 100, GOOD_WHEN.visitors).tone).toBe('bad');
    expect(delta(112, 100, GOOD_WHEN.bounceRate).tone).toBe('bad');
    expect(delta(92, 100, GOOD_WHEN.bounceRate).tone).toBe('good');
  });

  it('leaves a metric with no opinion in the neutral colour', () => {
    expect(delta(112, 100, GOOD_WHEN.onlineNow).tone).toBe('neutral');
    expect(delta(112, 100).tone).toBe('neutral');
  });
});

describe('deltaPoints', () => {
  // A bounce rate from 38% to 41% moved three points. Calling that a rise of
  // 7.9% is arithmetically true and useless.
  it('measures a rate in points rather than in percent of a percent', () => {
    expect(deltaPoints(0.41, 0.38)).toMatchObject({ kind: 'up', label: '3 pts' });
    expect(deltaPoints(0.2, 0.45)).toMatchObject({ kind: 'down', label: '25 pts' });
  });

  it('can compare against a previous rate of zero, unlike a relative change', () => {
    expect(deltaPoints(0.1, 0)).toMatchObject({ kind: 'up', label: '10 pts' });
  });

  it('has no answer when the previous rate was never computed', () => {
    expect(deltaPoints(0.41, null).kind).toBe('none');
  });
});

describe('viewsPerVisit', () => {
  it('divides, and refuses to divide by nothing', () => {
    expect(formatRatio(viewsPerVisit(4_930, 1_700))).toBe('2.9');
    expect(viewsPerVisit(0, 0)).toBeNull();
    expect(formatRatio(viewsPerVisit(12, 0))).toBeNull();
  });
});

describe('times', () => {
  const at = Date.UTC(2026, 8, 18, 4, 0, 0);

  // The lesson that cost a day in the backend: a site in Dhaka means its own
  // clock. This process runs in whatever zone the machine is in, and none of
  // these answers may depend on that.
  it('reads the clock in the site zone and not in the browser one', () => {
    expect(formatClock(at, DHAKA)).toBe('10:00');
    expect(formatClock(at, 'UTC')).toBe('04:00');
  });

  it('says how long ago for the last hour and the clock time after it', () => {
    expect(formatSince(at - 30_000, at, DHAKA)).toBe('now');
    expect(formatSince(at - 14 * 60_000, at, DHAKA)).toBe('14m');
    expect(formatSince(at - 3 * 60 * 60_000, at, DHAKA)).toBe('07:00');
  });

  it('counts online for from the start of the stay', () => {
    expect(formatOnlineFor(at - 14 * 60_000, at)).toBe('14m');
    expect(formatOnlineFor(at - 125 * 60_000, at)).toBe('2h 05m');
    // A stay that started a moment ago is zero minutes, never a negative.
    expect(formatOnlineFor(at + 5_000, at)).toBe('0m');
  });
});

describe('countryName', () => {
  // A flag emoji is the obvious answer and the wrong one: Windows ships no flag
  // glyphs, so a countries card drawn with them is a column of empty boxes on a
  // large share of the machines this is read from.
  it('names the country a code stands for', () => {
    expect(countryName('BD')).toBe('Bangladesh');
    expect(countryName('in')).toBe('India');
    expect(countryName('GB')).toBe('United Kingdom');
  });

  it('answers null for anything that is not a country code', () => {
    expect(countryName(undefined)).toBeNull();
    expect(countryName('')).toBeNull();
    expect(countryName('BDX')).toBeNull();
    expect(countryName('12')).toBeNull();
  });
});

describe('languageName', () => {
  it('names the language a tag stands for', () => {
    expect(languageName('bn')).toBe('Bangla');
    expect(languageName('en')).toBe('English');
    expect(languageName('pt-BR')).toBe('Brazilian Portuguese');
  });

  // Intl answers with the tag itself when it knows nothing, which would put the
  // same string in the label and in the code badge beside it.
  it('answers null rather than echoing a tag back', () => {
    expect(languageName('zz')).toBeNull();
    expect(languageName(undefined)).toBeNull();
    expect(languageName('')).toBeNull();
    expect(languageName('not a tag')).toBeNull();
  });
});
