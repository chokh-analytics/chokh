import { describe, expect, it } from 'vitest';
import type { Filter } from '@chokh/store/contract';

import {
  decodeFilters,
  dedupe,
  encodeFilters,
  isFilterable,
  removeFilter,
  toggleFilter,
} from './filters.js';

const page: Filter = { dim: 'page', op: 'is', value: '/pricing' };
const notFirefox: Filter = { dim: 'browser', op: 'is_not', value: 'Firefox' };
const dhaka: Filter = { dim: 'city', op: 'contains', value: 'Dhaka' };

describe('encodeFilters', () => {
  // The compact spelling the stats schema already parses, so a link is
  // something a person can read and hand edit.
  it('writes the compact form somebody can read', () => {
    expect(encodeFilters([page, notFirefox, dhaka])).toBe(
      'page==/pricing;browser!=Firefox;city~Dhaka',
    );
  });

  it('writes nothing at all when there are no filters', () => {
    expect(encodeFilters([])).toBe('');
  });

  // The compact form has no escape, so a value carrying a separator has to go
  // as JSON. Deciding that here means no call site has to know.
  it('falls back to JSON for a value the compact form cannot carry', () => {
    const tricky: Filter = { dim: 'page', op: 'is', value: '/a;b' };
    const encoded = encodeFilters([tricky]);
    expect(encoded.startsWith('[')).toBe(true);
    expect(decodeFilters(encoded)).toEqual([tricky]);
  });
});

describe('decodeFilters', () => {
  it('reads back what it wrote', () => {
    const filters = [page, notFirefox, dhaka];
    expect(decodeFilters(encodeFilters(filters))).toEqual(filters);
  });

  it('reads the JSON spelling a program would send', () => {
    expect(decodeFilters('[{"dim":"country","op":"is","value":"BD"}]')).toEqual([
      { dim: 'country', op: 'is', value: 'BD' },
    ]);
  });

  it('is empty for nothing at all', () => {
    expect(decodeFilters(null)).toEqual([]);
    expect(decodeFilters('')).toEqual([]);
    expect(decodeFilters('   ')).toEqual([]);
  });

  // A URL is something anybody can type. A page that refuses to load because a
  // character is wrong is worse than one that loads without a filter.
  it('drops a clause it cannot read and keeps the rest of the view', () => {
    expect(decodeFilters('page==/pricing;nonsense;country==BD')).toEqual([
      page,
      { dim: 'country', op: 'is', value: 'BD' },
    ]);
    expect(decodeFilters('notadimension==x')).toEqual([]);
    expect(decodeFilters('[{"broken":true}]')).toEqual([]);
    expect(decodeFilters('[not json at all')).toEqual([]);
  });

  // The store refuses these with UNSUPPORTED_FILTER because a raw event does
  // not carry them, so one never reaches it from here.
  it('drops a dimension only a stay carries', () => {
    expect(decodeFilters('entry==/home')).toEqual([]);
    expect(decodeFilters('exit==/pricing')).toEqual([]);
    expect(decodeFilters('channel==organic')).toEqual([]);
    expect(decodeFilters('page==/a;channel==organic')).toEqual([
      { dim: 'page', op: 'is', value: '/a' },
    ]);
  });

  it('keeps a value with an equals sign in it whole', () => {
    expect(decodeFilters('page==/search?q=a=b')).toEqual([
      { dim: 'page', op: 'is', value: '/search?q=a=b' },
    ]);
  });
});

describe('isFilterable', () => {
  it('knows which dimensions a row may be clicked on', () => {
    expect(isFilterable('page')).toBe(true);
    expect(isFilterable('country')).toBe(true);
    expect(isFilterable('entry')).toBe(false);
    expect(isFilterable('exit')).toBe(false);
    expect(isFilterable('channel')).toBe(false);
  });
});

describe('toggleFilter', () => {
  it('adds a filter a row was clicked for', () => {
    expect(toggleFilter([], page)).toEqual([page]);
  });

  // The second click on the same row is somebody undoing the first.
  it('takes the same filter off again', () => {
    expect(toggleFilter([page], page)).toEqual([]);
  });

  // Two values of one dimension with "is" can never both be true, and a query
  // that can never match looks exactly like a site with no traffic.
  it('replaces rather than stacking two values of one dimension', () => {
    const other: Filter = { dim: 'page', op: 'is', value: '/docs' };
    expect(toggleFilter([page, notFirefox], other)).toEqual([notFirefox, other]);
  });

  it('lets two exclusions of one dimension stand together', () => {
    const notSafari: Filter = { dim: 'browser', op: 'is_not', value: 'Safari' };
    expect(toggleFilter([notFirefox], notSafari)).toEqual([notFirefox, notSafari]);
  });

  // A row that cannot filter is not clickable, and this is the guard behind
  // that: even a click that somehow happened changes nothing.
  it('refuses a dimension the store cannot filter by', () => {
    const entry: Filter = { dim: 'entry', op: 'is', value: '/home' };
    expect(toggleFilter([page], entry)).toEqual([page]);
  });
});

describe('removeFilter and dedupe', () => {
  it('removes exactly the one named', () => {
    expect(removeFilter([page, notFirefox], page)).toEqual([notFirefox]);
    expect(removeFilter([page], notFirefox)).toEqual([page]);
  });

  it('keeps one of a pair that says the same thing twice', () => {
    expect(dedupe([page, { ...page }, notFirefox])).toEqual([page, notFirefox]);
  });
});
