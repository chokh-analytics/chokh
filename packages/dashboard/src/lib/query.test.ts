import { describe, expect, it } from 'vitest';

import {
  cacheKey,
  DEFAULT_COMPARE,
  DEFAULT_METRIC,
  DEFAULT_PRESET,
  parseQuery,
  requestedGoal,
  requestedVs,
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
    expect(query.goal).toBeNull();
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

  it('reads the filters, a dimension only a stay carries included', () => {
    expect(parse('filters=page%3D%3D%2Fpricing').filters).toEqual([
      { dim: 'page', op: 'is', value: '/pricing' },
    ]);
    expect(parse('filters=entry%3D%3D%2Fhome').filters).toEqual([
      { dim: 'entry', op: 'is', value: '/home' },
    ]);
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

// A goal in a link is only as good as the site's list: an id the site does not
// have is dropped, like any other parameter that makes no sense, rather than
// sent to a server that will answer every card with GOAL_NOT_FOUND.
describe('the goal', () => {
  const GOALS = ['g_signup', 'g_paid'];

  it('is kept when the site has it, and written back into the link', () => {
    const query = parseQuery('goal=g_signup', NOW, DHAKA, GOALS);
    expect(query.goal).toBe('g_signup');
    expect(toSearch(query)).toBe('?goal=g_signup');
  });

  it('is dropped when the site does not have it', () => {
    expect(parseQuery('goal=g_deleted', NOW, DHAKA, GOALS).goal).toBeNull();
  });

  it('is dropped when there is no list to vouch for it', () => {
    expect(parseQuery('goal=g_signup', NOW, DHAKA).goal).toBeNull();
  });

  it('is dropped when it is not the shape of an id at all', () => {
    expect(requestedGoal('goal=%3Cscript%3E')).toBeNull();
    expect(requestedGoal('goal=g_signup')).toBe('g_signup');
  });

  it('goes to a read only when the read asks for it', () => {
    const query = parseQuery('goal=g_signup', NOW, DHAKA, GOALS);
    expect(toStatsParams(query).goal).toBeUndefined();
    expect(toStatsParams(query, { dim: 'page' }).goal).toBeUndefined();
    expect(toStatsParams(query, { dim: 'page', goal: true }).goal).toBe('g_signup');
    expect(toStatsParams(parse(''), { goal: true }).goal).toBeUndefined();
  });

  it('files a read with a goal apart from the same read without one', () => {
    const query = parseQuery('goal=g_signup', NOW, DHAKA, GOALS);
    expect(cacheKey('s_1', toStatsParams(query, { goal: true }))).not.toEqual(
      cacheKey('s_1', toStatsParams(query)),
    );
  });
});

// The segment a link compares against is vouched for the way a goal is: by
// the site's own list, and by the shape of an id before that.
describe('the segment compared against', () => {
  const MOBILE = 'sg_AbCdEfGhIjKlMnOp';
  const SEGMENTS = [MOBILE, 'sg_QrStUvWxYz012345'];

  it('is kept when the site has it, and written back into the link', () => {
    const query = parseQuery(`vs=${MOBILE}`, NOW, DHAKA, [], SEGMENTS);
    expect(query.vs).toBe(MOBILE);
    expect(toSearch(query)).toBe(`?vs=${MOBILE}`);
  });

  it('is dropped when the site does not have it, or there is no list', () => {
    expect(parseQuery('vs=sg_ZzZzZzZzZzZzZzZz', NOW, DHAKA, [], SEGMENTS).vs).toBeNull();
    expect(parseQuery(`vs=${MOBILE}`, NOW, DHAKA).vs).toBeNull();
  });

  it('is dropped when it is not the shape of an id at all', () => {
    expect(requestedVs('vs=%3Cscript%3E')).toBeNull();
    expect(requestedVs('vs=g_signup')).toBeNull();
    expect(requestedVs(`vs=${MOBILE}`)).toBe(MOBILE);
  });

  it('never reaches a read: the chart asks for the segment series itself', () => {
    const query = parseQuery(`vs=${MOBILE}`, NOW, DHAKA, [], SEGMENTS);
    expect(JSON.stringify(toStatsParams(query))).not.toContain(MOBILE);
  });
});
