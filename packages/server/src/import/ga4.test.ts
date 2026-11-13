import { describe, expect, it } from 'vitest';

import { fixtureFiles, find, keys } from './fixtures.test-utils.js';
import { parseGa4 } from './ga4.js';

// The fixture is six GA4 Data API runReport responses (Google's
// RunReportResponse reference), two invented days of an invented property.

const parsed = parseGa4(fixtureFiles('ga4'));
const rows = parsed.rows.rows([]);

describe('parseGa4', () => {
  it('takes the totals from the date-only report: bounces are sessions not engaged', () => {
    expect(find(rows, '2025-01-01', 'total')).toEqual({
      date: '2025-01-01',
      dim: 'total',
      key: '',
      visitors: 40,
      pageviews: 95,
      visits: 50,
      bounces: 20,
      // averageSessionDuration (62.5 s) times sessions (50), in milliseconds.
      durationSum: 3_125_000,
    });
  });

  it('reads pagePath as pages, leaving "(not set)" out and saying so', () => {
    expect(keys(rows, '2025-01-01', 'page')).toEqual(['/', '/pricing']);
    expect(find(rows, '2025-01-01', 'page', '/pricing')).toMatchObject({ visitors: 12, pageviews: 35, visits: 0 });
    expect(keys(rows, '2025-01-02', 'page')).toEqual(['/']);
    expect(parsed.rows.skipped.get('a pagePath row of "(not set)"')).toBe(1);
  });

  it("maps GA4's channel groups to Chokh's, leaving out the ones with no counterpart", () => {
    expect(keys(rows, '2025-01-01', 'channel')).toEqual(['direct', 'organic']);
    expect(keys(rows, '2025-01-02', 'channel')).toEqual([]);
    expect(parsed.rows.skipped.get('a channel group Chokh has no name for (Unassigned)')).toBe(1);
  });

  it('reads deviceCategory as devices, and a smart TV as nothing Chokh files', () => {
    expect(find(rows, '2025-01-01', 'device', 'mobile')).toMatchObject({ visitors: 15, visits: 20, bounces: 10, durationSum: 1_010_000 });
    expect(keys(rows, '2025-01-02', 'device')).toEqual(['mobile']);
  });

  it("keeps a site's own events and leaves GA4's automatic ones out", () => {
    expect(keys(rows, '2025-01-01', 'event')).toEqual(['sign_up']);
    expect(find(rows, '2025-01-01', 'event', 'sign_up')?.visitors).toBe(3);
  });

  it('reads countryId as an ISO country, whichever column the date is in', () => {
    expect(keys(rows, '2025-01-01', 'country')).toEqual(['BD']);
  });

  it("names the property's time zone and what the bounce means", () => {
    expect(parsed.notes).toContain('GA4 property time zone: Asia/Dhaka');
    expect(parsed.notes.some((note) => note.includes('not engaged'))).toBe(true);
  });

  it('refuses reports without a totals report, with two breakdowns, or with a dimension Chokh lacks', () => {
    const report = (dimensions: string[]) =>
      JSON.stringify({ dimensionHeaders: dimensions.map((name) => ({ name })), metricHeaders: [{ name: 'totalUsers' }], rows: [] });
    expect(() => parseGa4([{ name: 'pages.json', text: report(['date', 'pagePath']) }])).toThrow('no report with the date dimension alone');
    expect(() => parseGa4([{ name: 'two.json', text: report(['date', 'pagePath', 'city']) }])).toThrow('at most one other');
    expect(() => parseGa4([{ name: 'odd.json', text: report(['date', 'newVsReturning']) }])).toThrow('has no Chokh dimension');
    expect(() => parseGa4([{ name: 'bad.json', text: '{' }])).toThrow('is not JSON');
  });
});
