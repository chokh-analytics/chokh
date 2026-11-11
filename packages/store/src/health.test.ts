import { describe, expect, it } from 'vitest';

import {
  COVERAGE_MIN_PEOPLE,
  VITAL_MIN_SAMPLES,
  assertHealthRange,
  foldCoverage,
  foldErrors,
  foldVitals,
  rateVitalBucket,
  vitalBucket,
  vitalFigure,
} from './health.js';

const DAY = 24 * 60 * 60 * 1000;

describe('vitalBucket', () => {
  it('rounds milliseconds up to 10 ms and CLS up to 0.01, never down', () => {
    expect(vitalBucket('LCP', 2500)).toBe(250);
    expect(vitalBucket('LCP', 2500.4)).toBe(250);
    expect(vitalBucket('LCP', 2500.5)).toBe(251);
    expect(vitalBucket('LCP', 2501)).toBe(251);
    expect(vitalBucket('INP', 0)).toBe(0);
    expect(vitalBucket('CLS', 0.1)).toBe(10);
    // 0.1 + 0.2 is 0.30000000000000004 as a double: still 0.30.
    expect(vitalBucket('CLS', 0.1 + 0.2)).toBe(30);
    expect(vitalBucket('CLS', 0.101)).toBe(11);
  });

  it('refuses what nobody could have measured', () => {
    expect(vitalBucket('LCP', -1)).toBeNull();
    expect(vitalBucket('LCP', 600_001)).toBeNull();
    expect(vitalBucket('CLS', 101)).toBeNull();
    expect(vitalBucket('TTFB', Number.NaN)).toBeNull();
    expect(vitalBucket('FCP', Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('rateVitalBucket', () => {
  it('reads the published thresholds, the boundary itself on the better side', () => {
    expect(rateVitalBucket('LCP', 250)).toBe('good');
    expect(rateVitalBucket('LCP', 251)).toBe('needs-improvement');
    expect(rateVitalBucket('LCP', 400)).toBe('needs-improvement');
    expect(rateVitalBucket('LCP', 401)).toBe('poor');
    expect(rateVitalBucket('INP', 20)).toBe('good');
    expect(rateVitalBucket('INP', 51)).toBe('poor');
    expect(rateVitalBucket('CLS', 10)).toBe('good');
    expect(rateVitalBucket('CLS', 25)).toBe('needs-improvement');
    expect(rateVitalBucket('CLS', 26)).toBe('poor');
    expect(rateVitalBucket('FCP', 180)).toBe('good');
    expect(rateVitalBucket('TTFB', 181)).toBe('poor');
  });
});

describe('vitalFigure', () => {
  it('takes the nearest rank p75 and says too few below the minimum', () => {
    const histogram = new Map<number, number>();
    for (let q = 1; q <= 20; q += 1) histogram.set(q * 10, 1);
    // Twenty samples, 100 ms to 2,000 ms: rank 15 is 1,500 ms.
    expect(vitalFigure('LCP', histogram)).toEqual({ p75: 1500, samples: 20, rating: 'good' });
    histogram.delete(200);
    expect(vitalFigure('LCP', histogram)).toEqual({
      p75: null,
      samples: VITAL_MIN_SAMPLES - 1,
      rating: null,
    });
  });

  it('counts repeated buckets as their weight', () => {
    expect(vitalFigure('CLS', new Map([[5, 15], [30, 5]]))).toEqual({
      p75: 0.05,
      samples: 20,
      rating: 'good',
    });
    expect(vitalFigure('CLS', new Map([[5, 14], [30, 6]]))).toEqual({
      p75: 0.3,
      samples: 20,
      rating: 'poor',
    });
  });
});

describe('foldVitals', () => {
  const twenty = (q: number) => [{ q, n: 20 }];

  it('adds page histograms into the site and device figures and orders the pages', () => {
    const result = foldVitals([
      { page: '/b', device: 'mobile', metric: 'LCP', buckets: twenty(300) },
      { page: '/a', device: 'desktop', metric: 'LCP', buckets: twenty(100) },
      { page: '/c', device: 'desktop', metric: 'LCP', buckets: [{ q: 900, n: 3 }] },
      { page: '/d', device: '', metric: 'LCP', buckets: twenty(300) },
    ]);
    const lcp = result.metrics[0]!;
    expect(lcp.samples).toBe(63);
    expect(lcp.devices.map((each) => each.device)).toEqual(['desktop', 'mobile', '']);
    // Two pages at 3 s: more samples first, then by name; too few last.
    expect(result.pages.map((page) => page.page)).toEqual(['/b', '/d', '/a', '/c']);
    expect(result.pagesTotal).toBe(4);
  });

  it('keeps at most fifty pages and counts the rest', () => {
    const cells = Array.from({ length: 60 }, (_, at) => ({
      page: `/p${at}`,
      device: 'desktop',
      metric: 'LCP' as const,
      buckets: twenty(at),
    }));
    const result = foldVitals(cells);
    expect(result.pages).toHaveLength(50);
    expect(result.pagesTotal).toBe(60);
    expect(result.pages[0]?.page).toBe('/p59');
  });
});

describe('foldErrors', () => {
  it('orders by count, then the newest, then the message, and keeps the total it is given', () => {
    const sample = { at: 1, page: '/', browser: 'Chrome' };
    const result = foldErrors(
      {
        total: 7,
        visitors: 3,
        groupsTotal: 3,
        messages: [
          { message: 'b', count: 2, visitors: 1, firstSeen: 1, lastSeen: 5, sample },
          { message: 'a', count: 2, visitors: 1, firstSeen: 1, lastSeen: 5, sample },
          { message: 'c', count: 3, visitors: 2, firstSeen: 1, lastSeen: 2, sample },
        ],
        pages: [
          { message: 'c', key: '/z', count: 1 },
          { message: 'c', key: '/y', count: 2 },
        ],
        browsers: [],
      },
      2,
    );
    expect(result.groups.map((group) => group.message)).toEqual(['c', 'a']);
    expect(result.groups[0]?.pages).toEqual([
      { page: '/y', count: 2 },
      { page: '/z', count: 1 },
    ]);
    expect(result.groupsTotal).toBe(3);
  });
});

describe('foldCoverage', () => {
  const people = (server: number, seen: number) =>
    Array.from({ length: server }, (_, at) => ({ userId: `u${at}`, server: true, browser: at < seen }));

  it('answers a share only with server events, browser identities and enough people', () => {
    expect(foldCoverage([]).state).toBe('no_server_events');
    expect(foldCoverage(people(COVERAGE_MIN_PEOPLE, 0)).state).toBe('no_browser_identity');
    expect(foldCoverage(people(COVERAGE_MIN_PEOPLE - 1, 5))).toMatchObject({ state: 'too_few', share: null });
    expect(foldCoverage(people(40, 30))).toMatchObject({ state: 'ok', share: 0.25, serverOnly: 10 });
  });
});

describe('assertHealthRange', () => {
  it('allows 90 days and the hour a clock change adds, and nothing longer', () => {
    expect(() => assertHealthRange(0, 90 * DAY + 60 * 60 * 1000)).not.toThrow();
    expect(() => assertHealthRange(0, 91 * DAY)).toThrow(/90 days/);
  });
});
