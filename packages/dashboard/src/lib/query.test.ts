import { describe, expect, it } from 'vitest';

import {
  cacheKey,
  DEFAULT_COMPARE,
  DEFAULT_METRIC,
  DEFAULT_PRESET,
  parseQuery,
  toSearch,
  toStatsParams,
  type ViewQuery,
} from './query.js';
import { resolvePreset } from './range.js';

const DHAKA = 'Asia/Dhaka';
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const TODAY_START = Date.UTC(2026, 8, 17, 18, 0, 0);

function parse(search: string): ViewQuery {
  return parseQuery(search, NOW, DHAKA);
}

describe('parseQuery', () => {
  it('has a whole view in it before anybody chooses anything', () => {
    const query = parse('');
    expect(query.range).toEqual(resolvePreset(DEFAULT_PRESET, NOW, DHAKA));
    // On by default. A number without a comparison is a number nobody can act
    // on, which is the second of the five rules this dashboard is built around.
    expect(query.compare).toBe(DEFAULT_COMPARE);
    expect(query.filters).toEqual([]);
    expect(query.interval).toBeNull();
    expect(query.metric).toBe(DEFAULT_METRIC);
  });

  it('reads a preset, and reads it in the site zone', () => {
    expect(parse('range=today').range.from).toBe(TODAY_START);
    expect(parseQuery('range=today', NOW, 'UTC').range.from).toBe(Date.UTC(2026, 8, 18));
  });

  it('reads a custom window as epoch milliseconds', () => {
    const query = parse(`range=custom&from=${TODAY_START}&to=${NOW}`);
    expect(query.range).toEqual({ preset: 'custom', from: TODAY_START, to: NOW });
  });

  // Both callers are real: a dashboard writes milliseconds, and a person
  // editing a link writes a date.
  it('reads a custom window as two dates a person typed', () => {
    const query = parse('range=custom&from=2026-09-16&to=2026-09-17');
    expect(query.range.from).toBe(Date.UTC(2026, 8, 15, 18, 0, 0));
    expect(query.range.to).toBe(TODAY_START);
  });

  // A page that refuses to load because a character is wrong is worse than one
  // that loads the default window.
  it('falls back rather than failing on a window it cannot read', () => {
    expect(parse('range=custom&from=2026-09-16').range).toEqual(
      resolvePreset(DEFAULT_PRESET, NOW, DHAKA),
    );
    expect(parse('range=custom&from=banana&to=pear').range.preset).toBe(DEFAULT_PRESET);
    expect(parse(`range=custom&from=${NOW}&to=${TODAY_START}`).range.preset).toBe(DEFAULT_PRESET);
    expect(parse('range=fortnight').range.preset).toBe(DEFAULT_PRESET);
  });

  // Turning a comparison off has to survive a reload as firmly as turning it
  // on, which it cannot do if "absent" and "off" are the same thing.
  it('keeps a comparison somebody turned off', () => {
    expect(parse('compare=off').compare).toBeNull();
    expect(parse('compare=previous_year').compare).toBe('previous_year');
    expect(parse('compare=nonsense').compare).toBe(DEFAULT_COMPARE);
  });

  it('reads the filters and drops the ones the store would refuse', () => {
    expect(parse('filters=page%3D%3D%2Fpricing').filters).toEqual([
      { dim: 'page', op: 'is', value: '/pricing' },
    ]);
    expect(parse('filters=entry%3D%3D%2Fhome').filters).toEqual([]);
  });

  // An interval the range cannot carry is a request the store would refuse, so
  // it is dropped and the range decides instead.
  it('ignores an interval this range cannot be drawn at', () => {
    expect(parse('range=today&interval=hour').interval).toBe('hour');
    expect(parse('range=30d&interval=hour').interval).toBeNull();
    expect(parse('range=30d&interval=minute').interval).toBeNull();
    expect(parse('range=today&interval=fortnight').interval).toBeNull();
  });

  it('reads the chart metric, and ignores one it does not draw', () => {
    expect(parse('metric=pageviews').metric).toBe('pageviews');
    expect(parse('metric=invented').metric).toBe(DEFAULT_METRIC);
  });
});

describe('toSearch', () => {
  // The common case is a short link, and what is in it is what somebody chose.
  it('writes nothing for a view nobody has changed', () => {
    expect(toSearch(parse(''))).toBe('');
  });

  it('round trips every view it can write', () => {
    for (const search of [
      'range=today',
      'range=30d&metric=pageviews',
      'compare=off',
      'compare=previous_year',
      'range=today&interval=minute',
      'filters=page%3D%3D%2Fpricing%3Bcountry%3D%3DBD',
      `range=custom&from=${TODAY_START}&to=${NOW}`,
    ]) {
      const once = parse(search);
      const twice = parse(toSearch(once).slice(1));
      expect(twice, search).toEqual(once);
    }
  });

  it('spells a custom window in milliseconds, whatever it was read from', () => {
    const query = parse('range=custom&from=2026-09-16&to=2026-09-17');
    expect(toSearch(query)).toBe(
      `?range=custom&from=${Date.UTC(2026, 8, 15, 18, 0, 0)}&to=${TODAY_START}`,
    );
  });
});

describe('toStatsParams', () => {
  it('sends the resolved window and an interval the store will answer', () => {
    const params = toStatsParams(parse('range=today'));
    expect(params.from).toBe(TODAY_START);
    expect(params.to).toBe(NOW);
    expect(params.interval).toBe('hour');
    expect(params.compare).toBe(DEFAULT_COMPARE);
  });

  it('leaves the comparison out when somebody turned it off', () => {
    expect(toStatsParams(parse('compare=off')).compare).toBeUndefined();
  });

  it('carries a dimension and a limit when a card asks for one', () => {
    const params = toStatsParams(parse(''), { dim: 'page', limit: 5 });
    expect(params.dim).toBe('page');
    expect(params.limit).toBe(5);
  });

  it('lets a card override the interval, which is what the sparkline does', () => {
    expect(toStatsParams(parse('range=today'), { interval: 'minute' }).interval).toBe('minute');
  });
});

describe('cacheKey', () => {
  // The lesson the backend learned the same way: two spellings of the same days
  // share one upstream read instead of each paying for its own.
  it('files the two spellings of one window under one key', () => {
    const fromMillis = parse(`range=custom&from=${Date.UTC(2026, 8, 15, 18)}&to=${TODAY_START}`);
    const fromDates = parse('range=custom&from=2026-09-16&to=2026-09-17');
    expect(cacheKey('s_1', toStatsParams(fromDates))).toEqual(
      cacheKey('s_1', toStatsParams(fromMillis)),
    );
  });

  it('files two different sites apart', () => {
    const params = toStatsParams(parse(''));
    expect(cacheKey('s_1', params)).not.toEqual(cacheKey('s_2', params));
  });

  it('files two different filters apart', () => {
    expect(cacheKey('s_1', toStatsParams(parse('filters=country%3D%3DBD')))).not.toEqual(
      cacheKey('s_1', toStatsParams(parse('filters=country%3D%3DIN'))),
    );
  });
});
