import { describe, expect, it } from 'vitest';

import {
  finishJourneys,
  journeyBranches,
  journeyPath,
  journeyStepCounts,
  topJourneyPages,
} from './journey.js';

describe('journeyPath', () => {
  it('counts a page repeated back to back once and keeps the first four', () => {
    expect(journeyPath(['/a', '/a', '/b', '/c', '/d', '/e'])).toEqual({
      steps: ['/a', '/b', '/c', '/d'],
      onward: true,
    });
    // A page repeated after another page is a step again.
    expect(journeyPath(['/a', '/b', '/a'])).toEqual({ steps: ['/a', '/b', '/a'], onward: false });
    expect(journeyPath(['/a', '/b', '/c', '/d', '/d'])).toEqual({
      steps: ['/a', '/b', '/c', '/d'],
      onward: false,
    });
  });
});

describe('journeyBranches', () => {
  it('takes five unless asked, and refuses what no column can hold', () => {
    expect(journeyBranches({ siteId: 's', from: 0, to: 1 })).toBe(5);
    expect(journeyBranches({ siteId: 's', from: 0, to: 1, branches: 10 })).toBe(10);
    for (const branches of [0, 11, 2.5]) {
      expect(() => journeyBranches({ siteId: 's', from: 0, to: 1, branches })).toThrow(
        expect.objectContaining({ code: 'INVALID_BRANCHES' }),
      );
    }
  });
});

describe('the fold', () => {
  const paths = [
    journeyPath(['/a', '/b']),
    journeyPath(['/a', '/c']),
    journeyPath(['/a']),
    journeyPath(['/b', '/b', '/c']),
    journeyPath(['/c', '/a', '/b', '/c', '/d']),
  ];

  it('keeps the most visited pages of each column, ties by path', () => {
    // The second column is /c twice, then /a and /b once each: the tie goes
    // to /a on the path.
    expect(topJourneyPages(paths, 2)).toEqual([
      ['/a', '/b'],
      ['/c', '/a'],
      ['/b'],
      ['/c'],
    ]);
  });

  it('folds the rest into Other, keeps what came after, and makes every column add up', () => {
    const result = finishJourneys(journeyStepCounts(paths, topJourneyPages(paths, 1)), 1);
    expect(result.visits).toBe(5);
    expect(result.columns[0]).toEqual([
      { key: '/a', visits: 3, exits: 1, onward: 0 },
      { key: null, visits: 2, exits: 0, onward: 0 },
    ]);
    // /a went on to /b, which is Other in the second column; /c came in from
    // both nodes of the first.
    expect(result.columns[1]).toEqual([
      { key: '/c', visits: 2, exits: 2, onward: 0 },
      { key: null, visits: 2, exits: 1, onward: 0 },
    ]);
    expect(result.columns[3]).toEqual([{ key: '/c', visits: 1, exits: 0, onward: 1 }]);
    for (const column of result.columns) {
      for (const node of column) {
        const out = result.links
          .filter((link) => link.column === result.columns.indexOf(column) && link.from === node.key)
          .reduce((total, link) => total + link.visits, 0);
        expect(out + node.exits + node.onward).toBe(node.visits);
      }
    }
    expect(result.links.filter((link) => link.column === 0)).toEqual([
      { column: 0, from: '/a', to: '/c', visits: 1 },
      { column: 0, from: '/a', to: null, visits: 1 },
      { column: 0, from: null, to: '/c', visits: 1 },
      { column: 0, from: null, to: null, visits: 1 },
    ]);
  });

  it('answers four empty columns for nobody', () => {
    expect(finishJourneys([], 5)).toEqual({
      visits: 0,
      columns: [[], [], [], []],
      links: [],
      branches: 5,
      rawOnly: true,
    });
  });
});
