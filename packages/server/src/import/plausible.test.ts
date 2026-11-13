import { describe, expect, it } from 'vitest';

import { fixtureFiles, find, keys } from './fixtures.test-utils.js';
import { parsePlausible, plausibleTable } from './plausible.js';

// The fixture is Plausible's documented CSV format (plausible.io/docs/csv-import),
// two invented days. Every number below is worked out from those files by hand.

const rows = parsePlausible(fixtureFiles('plausible')).rows.rows([]);

describe('plausibleTable', () => {
  it('reads the table from the file name, with or without the dates', () => {
    expect(plausibleTable('imported_entry_pages_20230209_20240123.csv')).toBe('entry_pages');
    expect(plausibleTable('export/imported_operating_systems.csv')).toBe('operating_systems');
    expect(plausibleTable('imported_weather_20230209_20240123.csv')).toBeUndefined();
    expect(plausibleTable('visitors.csv')).toBeUndefined();
  });
});

describe('parsePlausible', () => {
  it('takes the day totals from imported_visitors, duration from seconds to milliseconds', () => {
    expect(find(rows, '2025-01-01', 'total')).toEqual({
      date: '2025-01-01',
      dim: 'total',
      key: '',
      visitors: 10,
      pageviews: 25,
      visits: 12,
      bounces: 4,
      durationSum: 600_000,
    });
    // The bot series beside it, so a humans-only read finds the same.
    expect(find(rows, '2025-01-01', 'bot', 'false')).toMatchObject({ visitors: 10, pageviews: 25 });
  });

  it('adds a page served on two hostnames into one page, and gives each its route', () => {
    expect(find(rows, '2025-01-01', 'page', '/')).toMatchObject({ visitors: 9, pageviews: 15, visits: 0 });
    expect(find(rows, '2025-01-01', 'route', '/')).toMatchObject({ visitors: 9, pageviews: 15 });
    expect(keys(rows, '2025-01-02', 'page')).toEqual(['/', '/blog/hello']);
  });

  it('folds pages into routes by the site rules', () => {
    const routed = parsePlausible(fixtureFiles('plausible')).rows.rows(['/blog/:slug']);
    expect(keys(routed, '2025-01-02', 'route')).toEqual(['/', '/blog/:slug']);
  });

  it('reads entrances and exits as the visits of the entry and exit pages', () => {
    expect(find(rows, '2025-01-01', 'entry', '/')).toMatchObject({ visitors: 8, visits: 9, bounces: 3, durationSum: 400_000, pageviews: 18 });
    expect(find(rows, '2025-01-01', 'exit', '/pricing')).toMatchObject({ visits: 7, durationSum: 350_000 });
  });

  it('files sources as a referrer URL, the UTM tags and the channel Chokh would give them', () => {
    expect(keys(rows, '2025-01-01', 'referrer')).toEqual(['https://google.com']);
    expect(find(rows, '2025-01-01', 'utm_medium', 'email')).toMatchObject({ visitors: 3, visits: 4 });
    expect(find(rows, '2025-01-01', 'utm_campaign', 'january')?.visitors).toBe(3);
    expect(keys(rows, '2025-01-01', 'channel')).toEqual(['direct', 'email', 'organic']);
    expect(find(rows, '2025-01-01', 'channel', 'organic')).toMatchObject({ visitors: 5, visits: 6, pageviews: 12 });
    expect(keys(rows, '2025-01-02', 'channel')).toEqual(['organic']);
  });

  it('adds regions of one country together and imports no region or city', () => {
    expect(find(rows, '2025-01-01', 'country', 'BD')).toMatchObject({ visitors: 7, visits: 8, pageviews: 18 });
    expect(rows.some((row) => row.dim === 'region' || row.dim === 'city')).toBe(false);
  });

  it('files a laptop as a desktop, and adds browser versions together', () => {
    expect(find(rows, '2025-01-01', 'device', 'desktop')).toMatchObject({ visitors: 7, visits: 8 });
    expect(find(rows, '2025-01-01', 'device', 'mobile')?.visitors).toBe(3);
    expect(find(rows, '2025-01-01', 'browser', 'Chrome')).toMatchObject({ visitors: 7, visits: 8 });
    expect(keys(rows, '2025-01-01', 'os')).toEqual(['GNU/Linux', 'Windows']);
  });

  it('keeps visitors per custom event, which is all a rolled event row holds', () => {
    expect(find(rows, '2025-01-01', 'event', 'Outbound Link: Click')).toMatchObject({ visitors: 2, pageviews: 0 });
    expect(find(rows, '2025-01-02', 'event', '404')?.visitors).toBe(1);
  });

  it('refuses a set of files without imported_visitors, and a file that is not Plausible', () => {
    const withoutTotals = fixtureFiles('plausible').filter((file) => !file.name.startsWith('imported_visitors'));
    expect(() => parsePlausible(withoutTotals)).toThrow('imported_visitors is missing');
    expect(() => parsePlausible([{ name: 'report.csv', text: 'date\n' }])).toThrow('is not a Plausible export file');
  });
});
