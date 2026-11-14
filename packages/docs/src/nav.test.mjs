import { describe, expect, it } from 'vitest';

import { checkNav } from './nav.mjs';

const NAV = [
  { section: 'Start here', pages: ['index'] },
  { section: 'The project', pages: ['licence'] },
];

describe('the navigation and the pages', () => {
  it('gives the pages in the order of the navigation when they agree', () => {
    expect(checkNav(NAV, ['licence', 'index'])).toEqual(['index', 'licence']);
  });

  it('refuses a page in no menu, and a menu entry with no page', () => {
    expect(() => checkNav(NAV, ['index', 'licence', 'orphan'])).toThrow(
      'In the navigation with no page: none. A page not in the navigation: orphan.',
    );
    expect(() => checkNav(NAV, ['index'])).toThrow('In the navigation with no page: licence.');
  });

  it('refuses a page named twice', () => {
    expect(() => checkNav([{ section: 'A', pages: ['index', 'index'] }], ['index'])).toThrow('named twice');
  });
});
