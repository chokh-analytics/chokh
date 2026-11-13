import { describe, expect, it } from 'vitest';

import { fixtureFiles, find, keys } from './fixtures.test-utils.js';
import { parseUmami, umamiInstant } from './umami.js';

// The fixture is Umami's two raw tables as CSV, columns as in its Prisma schema:
// three sessions, four visits, eight events of an invented site. The Chokh site
// is in Asia/Dhaka (UTC+6), so the visit at 19:30 UTC on the 1st is a visit of
// the 2nd, which is the point of counting instants into the site's days.

const parsed = parseUmami(fixtureFiles('umami'), { timezone: 'Asia/Dhaka' });
const rows = parsed.rows.rows([]);

describe('umamiInstant', () => {
  it('reads created_at as Postgres, MySQL or ISO writes it, a time with no zone as UTC', () => {
    expect(umamiInstant('2025-01-01 03:02:00.250+00')).toBe(Date.UTC(2025, 0, 1, 3, 2, 0, 250));
    expect(umamiInstant('2025-01-01 09:02:00+0600')).toBe(Date.UTC(2025, 0, 1, 3, 2, 0));
    expect(umamiInstant('2025-01-01 03:02:00')).toBe(Date.UTC(2025, 0, 1, 3, 2, 0));
    expect(umamiInstant('2025-01-01T03:02:00Z')).toBe(Date.UTC(2025, 0, 1, 3, 2, 0));
    expect(umamiInstant('yesterday')).toBeUndefined();
    expect(umamiInstant('')).toBeUndefined();
  });
});

describe('parseUmami', () => {
  it("counts the day's totals the way Chokh does, in the site's days", () => {
    // The 1st: one visit, two pageviews and a custom event, three minutes long.
    expect(find(rows, '2025-01-01', 'total')).toEqual({
      date: '2025-01-01',
      dim: 'total',
      key: '',
      visitors: 1,
      pageviews: 2,
      visits: 1,
      bounces: 0,
      durationSum: 180_000,
    });
    // The 2nd: the 19:30 UTC visit of the 1st, and two more; two of the three
    // are a single pageview. The five minute one ends at its last pageview: the
    // row after it is neither kind of event and is left out, time and all.
    expect(find(rows, '2025-01-02', 'total')).toMatchObject({ visitors: 3, pageviews: 4, visits: 3, bounces: 2, durationSum: 300_000 });
  });

  it('counts pages by distinct sessions and pageviews', () => {
    expect(find(rows, '2025-01-02', 'page', '/')).toMatchObject({ visitors: 2, pageviews: 2 });
    expect(keys(rows, '2025-01-02', 'page')).toEqual(['/', '/blog/hello', '/pricing']);
  });

  it("gives each visit its entry, exit, referrer and channel from its own rows", () => {
    expect(find(rows, '2025-01-01', 'entry', '/')).toMatchObject({ visits: 1, pageviews: 2, bounces: 0 });
    expect(find(rows, '2025-01-01', 'exit', '/pricing')?.visits).toBe(1);
    expect(keys(rows, '2025-01-01', 'referrer')).toEqual(['https://google.com/']);
    expect(keys(rows, '2025-01-01', 'channel')).toEqual(['organic']);
    // The UTM from url_query, for an export without the utm_ columns filled.
    expect(find(rows, '2025-01-02', 'utm_source', 'newsletter')?.visits).toBe(1);
    expect(find(rows, '2025-01-02', 'channel', 'email')).toMatchObject({ visits: 1, bounces: 1 });
    expect(find(rows, '2025-01-02', 'channel', 'direct')).toMatchObject({ visits: 2, visitors: 2 });
  });

  it("files the session's browser, system and device as the collector would, and keeps no region", () => {
    expect(keys(rows, '2025-01-02', 'browser')).toEqual(['Chrome', 'Firefox', 'Mobile Safari']);
    expect(find(rows, '2025-01-02', 'device', 'desktop')).toMatchObject({ visitors: 2, visits: 2 });
    expect(keys(rows, '2025-01-02', 'city')).toEqual(['Berlin', 'Dhaka']);
    expect(find(rows, '2025-01-02', 'screen', '390x844')).toMatchObject({ visitors: 1, pageviews: 1, visits: 0 });
    expect(rows.some((row) => row.dim === 'region')).toBe(false);
  });

  it('counts a custom event by its visitors, and leaves out what is neither kind', () => {
    expect(find(rows, '2025-01-01', 'event', 'signup')?.visitors).toBe(1);
    expect(parsed.rows.skipped.get('an event of type 3, neither a pageview nor a custom event')).toBe(1);
  });

  it('asks which website when an export holds two, and reads only that one', () => {
    const files = fixtureFiles('umami');
    const events = files.find((file) => file.name === 'website_event.csv');
    if (events === undefined) throw new Error('fixture missing');
    const lines = events.text.trimEnd().split('\n');
    const other = (lines[1] as string).replace(/5d7c3e1a-0b6f-4c2e-9a10-6f1d2a3b4c5d/g, '00000000-0000-4000-8000-0000000000ff');
    const twoSites = [...files.filter((file) => file !== events), { name: events.name, text: `${lines.join('\n')}\n${other}\n` }];
    expect(() => parseUmami(twoSites, { timezone: 'UTC' })).toThrow('name one with --website');
    const one = parseUmami(twoSites, { timezone: 'Asia/Dhaka', website: '5d7c3e1a-0b6f-4c2e-9a10-6f1d2a3b4c5d' }).rows.rows([]);
    expect(find(one, '2025-01-01', 'total')).toEqual(find(rows, '2025-01-01', 'total'));
  });
});
