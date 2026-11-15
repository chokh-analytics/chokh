import { describe, expect, it } from 'vitest';

import { demoCsvTable } from './downloads.js';

// Every kind of export a report of the demo links to is made in the page,
// with the server's own columns and the rows the report itself shows.
const SITE = 'http://demo.example/api/sites/s_demo/export.csv';
const RANGE = 'from=1&to=2';

describe("the demo's CSV downloads", () => {
  it.each([
    ['a breakdown', `${RANGE}&dim=page`, 'key'],
    ['a breakdown by a goal', `${RANGE}&dim=source&goal=g_signup`, 'key'],
    ['the chart', `${RANGE}&report=timeseries&interval=day`, 'series'],
    ['time on page', `${RANGE}&report=engagement&dim=page`, 'key'],
    ['the events', `${RANGE}&report=events`, 'key'],
    ['an event\'s properties', `${RANGE}&report=properties&event=signup`, 'event'],
    ['the goals', `${RANGE}&report=goals`, 'goal_id'],
    ['a funnel', `${RANGE}&report=funnel&funnel=f_course`, 'step'],
    ['the journeys', `${RANGE}&report=journeys&branches=5`, 'column'],
  ])('makes %s', (_, query, first) => {
    const table = demoCsvTable(new URL(`${SITE}?${query}`));
    expect(table?.header[0]).toBe(first);
    expect(table?.rows.length ?? 0).toBeGreaterThan(0);
  });

  it('makes nothing for an address that is not an export, or a kind it does not know', () => {
    expect(demoCsvTable(new URL('http://demo.example/api/sites/s_demo/stats/aggregate'))).toBeNull();
    expect(demoCsvTable(new URL(`${SITE}?${RANGE}&report=nonsense`))).toBeNull();
    expect(demoCsvTable(new URL(`${SITE}?${RANGE}&report=funnel&funnel=f_missing`))).toBeNull();
  });
});
