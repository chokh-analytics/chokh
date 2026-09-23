import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { CHART_HEIGHT } from '../ui/TimeChart.js';
import { Overview } from './Overview.js';

// What the page says when it does not know, which is the half of a dashboard
// nobody designs and everybody reads.
//
// Every case here is a shape that shipped looking right: a failed request drawn
// as an empty range, a live read that failed drawn as nobody being here, an
// average nobody measured drawn as a fall of a hundred percent, a bounce rate
// axis counted in whole visitors, and five rows that take a click and do
// nothing.

const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const TODAY_START = Date.UTC(2026, 8, 17, 18, 0, 0);

const SITE = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
  teamId: 'default',
  settings: {
    ipMode: 'anonymized' as const,
    visitorIdMode: 'persistent' as const,
    botFilter: true,
    retentionDays: 180,
    timezone: 'Asia/Dhaka',
    allowUnsignedIdentify: false,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
  },
};

function metrics(over: Record<string, number | null> = {}) {
  return {
    visitors: 315,
    pageviews: 712,
    visits: 306,
    bounces: 92,
    bounceRate: 0.3,
    avgDurationMs: 140_000,
    ...over,
  };
}

function ok(data: unknown, meta?: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data, meta }),
  } as unknown as Response;
}

function broken(code = 'INTERNAL'): Response {
  return {
    status: 500,
    ok: false,
    json: () => Promise.resolve({ success: false, error: { code, message: 'It broke.' } }),
  } as unknown as Response;
}

interface Routes {
  aggregate?: () => Response;
  timeseries?: () => Response;
  breakdown?: (dim: string) => Response;
  realtime?: () => Response;
}

function serve(routes: Routes = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/stats/aggregate')) {
        return Promise.resolve(
          (routes.aggregate ?? (() => ok({ metrics: metrics(), previous: metrics({ visitors: 250 }) })))(),
        );
      }
      if (url.includes('/stats/timeseries')) {
        return Promise.resolve(
          (routes.timeseries ??
            (() =>
              ok({
                interval: 'day',
                points: [
                  { start: TODAY_START, end: NOW, metrics: metrics() },
                  { start: TODAY_START + 86_400_000, end: NOW, metrics: metrics() },
                ],
                // A comparison is on by default, so the server answers with
                // one: a fixture that asks for compare and returns null is a
                // shape the store never produces.
                previous: [
                  { start: TODAY_START - 86_400_000, end: NOW, metrics: metrics({ visitors: 250 }) },
                  { start: TODAY_START, end: NOW, metrics: metrics({ visitors: 260 }) },
                ],
              })))(),
        );
      }
      if (url.includes('/realtime')) {
        return Promise.resolve(
          (routes.realtime ?? (() => ok({ online: 5, signedIn: 2, anonymous: 3 })))(),
        );
      }
      const dim = new URL(url, 'http://x').searchParams.get('dim') ?? '';
      if (routes.breakdown !== undefined) {
        return Promise.resolve(routes.breakdown(dim));
      }
      return Promise.resolve(
        ok({
          dim,
          rows: [
            { key: dim === 'channel' ? 'organic' : 'BD', metrics: metrics({ visitors: 200 }) },
            { key: dim === 'channel' ? 'social' : 'IN', metrics: metrics({ visitors: 40 }) },
          ],
        }),
      );
    }),
  );
}

// The number a tile shows, found by its label rather than by its value: the
// chart's hidden table carries the same figures, which is the point of it.
// The label appears in the chart's title and legend too, so this takes the
// occurrence that has a tile around it.
function tile(label: string): HTMLElement {
  const found = screen
    .getAllByText(label)
    .map((node) => node.closest('[class*="tile"]'))
    .find((node): node is HTMLElement => node !== null);
  if (found === undefined) {
    throw new Error(`No tile around ${label}`);
  }
  return found;
}

// A failed query is retried once with a backoff before it settles, so the error
// state legitimately takes longer than a default findBy waits.
const AFTER_RETRY = { timeout: 4_000 };

// The labels render at once and the numbers land with the request, so waiting
// for a label proves nothing. This waits for the totals themselves.
async function totalsLanded(): Promise<void> {
  await waitFor(() => expect(tile('Visitors')).not.toHaveTextContent(/^Visitors$/));
}

function show(over: Partial<AppContextValue> = {}): JSX.Element {
  const client = createClient({ fetch: globalThis.fetch });
  const value: AppContextValue = { client, me: { actor: { kind: 'session', id: 'u_1' }, user: null, sites: [SITE], teams: [] }, site: SITE, now: NOW, ...over };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Overview />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Overview, when things work', () => {
  it('shows the six numbers with their comparisons', async () => {
    serve();
    render(show());
    await totalsLanded();
    expect(tile('Visitors')).toHaveTextContent('315');
    expect(tile('Pageviews')).toHaveTextContent('712');
    expect(tile('Bounce rate')).toHaveTextContent('30%');
    expect(tile('Avg visit')).toHaveTextContent('2m 20s');
    // Every one of them carries a comparison, which is the second rule.
    expect(tile('Visitors')).toHaveTextContent('26%');
  });
});

describe('Overview, when it does not know', () => {
  // A failed series drawn as "No data in this range" is a statement about the
  // site rather than about the request, and it is the one somebody acts on.
  it('says a failed chart failed rather than saying the range is empty', async () => {
    serve({ timeseries: () => broken('RANGE_TOO_LONG') });
    render(show());
    expect(await screen.findByText('It broke.', {}, AFTER_RETRY)).toBeInTheDocument();
    expect(screen.queryByText('No data in this range.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  // "0 online" with a grey dot is indistinguishable from a quiet minute.
  it('never draws a failed live read as nobody being here', async () => {
    serve({ realtime: () => broken() });
    render(show());
    await totalsLanded();
    await waitFor(
      () => expect(tile('Online now')).toHaveTextContent('not available'),
      AFTER_RETRY,
    );
    expect(tile('Online now')).not.toHaveTextContent('0 signed in');
  });

  // The delta was computed against a zero nobody measured, so the tile read
  // "not available" beside a red "down 100%".
  it('gives an unmeasured average no delta rather than a fall to nothing', async () => {
    serve({
      aggregate: () =>
        ok({
          metrics: metrics({ avgDurationMs: null, bounceRate: null, visits: 0 }),
          previous: metrics({ avgDurationMs: 140_000 }),
        }),
    });
    render(show());
    await totalsLanded();
    expect(tile('Avg visit')).toHaveTextContent('not available');
    expect(tile('Avg visit')).not.toHaveTextContent('100%');
    expect(tile('Avg visit')).toHaveTextContent('no baseline');
  });

  it('shows a failed total as an error with a retry, not as zeroes', async () => {
    serve({ aggregate: () => broken() });
    render(show());
    expect(await screen.findByText('It broke.', {}, AFTER_RETRY)).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
  });
});

describe('Overview, how the numbers are written', () => {
  // Every series was a count, so a bounce rate axis read 0, 0, 1 under a tile
  // that said 30%.
  it('writes the chart in the units of the metric it is drawing', async () => {
    serve();
    window.history.replaceState(null, '', '/s_test?metric=bounceRate');
    render(show());
    await screen.findByText('Views per visit');
    const table = await screen.findByRole('table', { name: /numbers behind the chart/i });
    expect(table).toHaveTextContent('30%');
    expect(table).not.toHaveTextContent('0.3');
  });

  it('writes a duration chart as a duration', async () => {
    serve();
    window.history.replaceState(null, '', '/s_test?metric=avgDuration');
    render(show());
    await screen.findByText('Views per visit');
    const table = await screen.findByRole('table', { name: /numbers behind the chart/i });
    expect(table).toHaveTextContent('2m 20s');
    expect(table).not.toHaveTextContent('140K');
  });
});

describe('Overview, what a row does', () => {
  it('filters the whole page when a filterable row is clicked', async () => {
    serve();
    render(show());
    const row = await screen.findByRole('button', { name: /Bangladesh/ });
    await userEvent.click(row);
    await waitFor(() => expect(window.location.search).toContain('country%3D%3DBD'));
  });

  // The store refuses a filter naming a channel, so these five rows took a
  // click and changed nothing. A row that invites a press and does not answer
  // is worse than one that does not invite it.
  it('does not invite a click on a dimension the store cannot filter', async () => {
    serve();
    render(show());
    await screen.findByText('Organic search');
    expect(screen.queryByRole('button', { name: /Organic search/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Bangladesh/ })).toBeInTheDocument();
  });
});

// The skeleton is the exact height of the thing it stands in for, taken from
// the chart's own constant. A skeleton 190 tall in front of a drawing 220 tall
// is a layout shift on every load, and it is the kind nobody reports because it
// happens before anybody is reading.
// The chart panel is a head, a plot and a legend. A skeleton the height of the
// plot alone is short by the other two, so the whole page below it jumps when
// the numbers land, and it jumps before anybody is reading, which is why nobody
// reports it.
describe('Overview, while it loads', () => {
  // jsdom lays nothing out, so a rendered height is the sum of what each row
  // declares. Counting the rows and adding the blocks is the same comparison a
  // browser would make, done with the numbers the DOM actually carries.
  function panelShape(container: HTMLElement): { rows: string[]; blocks: string[] } {
    const panel = container.querySelector('[class*="chart_"]') as HTMLElement | null;
    if (panel === null) {
      throw new Error('no chart panel');
    }
    return {
      rows: [...panel.children].map((child) => child.className.replace(/_[a-z0-9]+$/i, '')),
      blocks: [...panel.querySelectorAll('[class*="skeleton"], svg')].map(
        (node) =>
          (node as HTMLElement).style.height ||
          `${(node as SVGElement).getAttribute('height') ?? ''}px`,
      ),
    };
  }

  it('is the same panel before and after the numbers land', async () => {
    serve();
    const { container } = render(show());
    const loading = panelShape(container);

    // The plot's place is held at exactly the height the drawing will be.
    expect(loading.blocks).toEqual([`${CHART_HEIGHT}px`]);

    await totalsLanded();
    await waitFor(() => expect(panelShape(container).blocks).toEqual([`${CHART_HEIGHT}px`]));

    // And every other row of the panel is the same row in both states, so
    // nothing above or below it moves.
    expect(panelShape(container).rows).toEqual(loading.rows);
  });
});

// A site nobody has visited is not a site with a quiet week. It showed a row of
// zeros, three tiles reading "not available" and a chart axis of 1, 1, 0: four
// measurements of a site that has not been measured.
describe('Overview, on a site with nothing in it', () => {
  function empty(): void {
    const zero = metrics({
      visitors: 0,
      pageviews: 0,
      visits: 0,
      bounces: 0,
      bounceRate: null,
      avgDurationMs: null,
    });
    serve({
      aggregate: () => ok({ metrics: zero, previous: null }),
      timeseries: () =>
        ok({
          interval: 'day',
          points: [
            { start: TODAY_START, end: NOW, metrics: zero },
            { start: TODAY_START + 86_400_000, end: NOW, metrics: zero },
          ],
          previous: null,
        }),
      breakdown: () => ok({ dim: 'page', rows: [] }),
      realtime: () => ok({ online: 0, signedIn: 0, anonymous: 0, recent: [] }),
    });
  }

  it('gives them the line of script rather than a page of zeros', async () => {
    empty();
    render(show());
    expect(await screen.findByRole('heading', { name: /Waiting for the first pageview/ })).toBeInTheDocument();
    expect(screen.getByText(/script defer/)).toBeInTheDocument();
    expect(screen.queryByText('Views per visit')).toBeNull();
  });

  it('says it is watching, and says so out loud', async () => {
    empty();
    render(show());
    await screen.findByRole('heading', { name: /Waiting for the first pageview/ });
    expect(screen.getByRole('status')).toHaveTextContent('Watching for it now.');
  });
});

// Three labels for a chart with nothing in it, two of them invented by the
// rounding: an empty series has a maximum of one, so the axis read 1, 1, 0.
describe('Overview, when a range is empty but the site is not', () => {
  it('puts no number on an axis it could not measure', async () => {
    const zero = metrics({ visitors: 0, pageviews: 0, bounceRate: null, avgDurationMs: null });
    serve({
      aggregate: () => ok({ metrics: zero, previous: null }),
      timeseries: () =>
        ok({
          interval: 'day',
          points: [{ start: TODAY_START, end: NOW, metrics: zero }],
          previous: null,
        }),
      // The site has been visited before, just not in this range.
      breakdown: () => ok({ dim: 'page', rows: [] }),
    });
    // The wider read that decides which empty state this is.
    render(show());
    await screen.findByText('No data in this range.');
    const axis = [...document.querySelectorAll('svg text')].map((node) => node.textContent);
    expect(axis.filter((label) => label === '1')).toHaveLength(0);
    expect(axis).toContain('0');
  });
});

// A live read that failed showed "not available" and nothing to press: the only
// way back was a reload of the whole dashboard.
describe('Overview, when the live read fails', () => {
  it('offers the same retry the cards have', async () => {
    serve({ realtime: () => broken() });
    render(show());
    await totalsLanded();
    await waitFor(
      () => expect(tile('Online now')).toHaveTextContent('Try again'),
      AFTER_RETRY,
    );
  });

  // Thirty pixels of "not avai..." is a truncated number. At body size it is a
  // sentence, which is what it is.
  it('sets an absent number in body size so it never truncates', async () => {
    serve({
      aggregate: () =>
        ok({ metrics: metrics({ avgDurationMs: null }), previous: null }),
    });
    const { container } = render(show());
    await totalsLanded();
    const absent = container.querySelector('[class*="absent"]');
    expect(absent).toHaveTextContent('not available');
  });
});

// A goal chosen in the range bar puts a second column on every card and a
// figure beside the goal's name. Two reads cannot take one: the server refuses
// a goal on a time series and on time on page, so a client that forwarded it
// would lose the chart the moment somebody chose a goal. That is ruling 4 of
// the AN-EVT01 plan review, and these cases are its proof on this page.
describe('Overview, with a goal chosen', () => {
  const GOAL = {
    siteId: 's_test',
    id: 'g_signup',
    kind: 'event' as const,
    match: 'signup',
    name: 'Signed up',
    createdBy: 'u_1',
    createdAt: NOW - 86_400_000,
  };

  function conversion(visitors: number, rate: number | null) {
    return { visitors, completions: visitors, rate, value: null };
  }

  function serveWithGoal(): string[] {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        const url = String(input);
        asked.push(url);
        const withGoal = new URL(url, 'http://x').searchParams.get('goal') !== null;
        const meta = withGoal ? { retentionDays: 90, rawOnly: true } : undefined;
        if (url.includes('/stats/aggregate')) {
          return Promise.resolve(
            ok(
              {
                metrics: metrics(),
                previous: metrics({ visitors: 250 }),
                ...(withGoal ? { conversion: conversion(38, 38 / 315) } : {}),
              },
              meta,
            ),
          );
        }
        if (url.includes('/stats/timeseries')) {
          return Promise.resolve(
            ok({
              interval: 'day',
              points: [
                { start: TODAY_START, end: NOW, metrics: metrics() },
                { start: TODAY_START + 86_400_000, end: NOW, metrics: metrics() },
              ],
              previous: null,
            }),
          );
        }
        if (url.includes('/realtime')) {
          return Promise.resolve(ok({ online: 5, signedIn: 2, anonymous: 3 }));
        }
        if (url.includes('/goals')) {
          return Promise.resolve(ok({ goals: [GOAL] }));
        }
        const dim = new URL(url, 'http://x').searchParams.get('dim') ?? '';
        return Promise.resolve(
          ok(
            {
              dim,
              rows: [
                {
                  key: dim === 'channel' ? 'organic' : 'BD',
                  metrics: metrics({ visitors: 200 }),
                  ...(withGoal ? { conversion: conversion(30, 0.15) } : {}),
                },
              ],
            },
            meta,
          ),
        );
      }),
    );
    return asked;
  }

  function reads(asked: string[], route: string): URLSearchParams[] {
    return asked
      .filter((url) => url.includes(`/stats/${route}`))
      .map((url) => new URL(url, 'http://x').searchParams);
  }

  it('still draws the chart, and asks the chart for no goal', async () => {
    const asked = serveWithGoal();
    window.history.replaceState(null, '', '/s_test?goal=g_signup');
    render(show({ goals: [GOAL] }));
    await totalsLanded();

    // The chart has its points: the hidden table under it carries one row per
    // day, which is what an empty or refused series would not.
    const table = await screen.findByText('The numbers behind the chart above.');
    await waitFor(() =>
      expect(table.closest('table')?.querySelectorAll('tbody tr')).toHaveLength(2),
    );

    expect(reads(asked, 'timeseries').length).toBeGreaterThan(0);
    expect(reads(asked, 'timeseries').every((params) => !params.has('goal'))).toBe(true);
    expect(reads(asked, 'engagement').every((params) => !params.has('goal'))).toBe(true);
    // And the reads that draw a conversion did carry it.
    expect(reads(asked, 'aggregate').some((params) => params.get('goal') === 'g_signup')).toBe(
      true,
    );
    expect(reads(asked, 'breakdown').every((params) => params.get('goal') === 'g_signup')).toBe(
      true,
    );
  });

  it('puts the rate on every card, with how many people it is on hover', async () => {
    serveWithGoal();
    window.history.replaceState(null, '', '/s_test?goal=g_signup');
    render(show({ goals: [GOAL] }));
    await totalsLanded();

    const sources = screen.getByRole('region', { name: 'Sources' });
    await waitFor(() => expect(sources).toHaveTextContent('15%'));
    const rate = [...sources.querySelectorAll('td')].find((cell) => cell.textContent === '15%');
    expect(rate).toHaveAttribute('title', '30 converted');
    // Two columns, so the card names them.
    expect(sources).toHaveTextContent('Conversion rate');
    // A goal read is raw, and the card says how far back it can see.
    expect(sources).toHaveTextContent('sees back 90 days');
  });

  it('says what share of the site reached it beside its name', async () => {
    serveWithGoal();
    window.history.replaceState(null, '', '/s_test?goal=g_signup');
    render(show({ goals: [GOAL] }));

    expect(await screen.findByText('Goal: Signed up')).toBeInTheDocument();
    expect(await screen.findByText('12% converted (38)')).toBeInTheDocument();
  });

  it('draws one column and asks for no goal when none is chosen', async () => {
    const asked = serveWithGoal();
    render(show({ goals: [GOAL] }));
    await totalsLanded();
    const sources = screen.getByRole('region', { name: 'Sources' });
    await waitFor(() => expect(sources).toHaveTextContent('Organic search'));

    expect(sources).not.toHaveTextContent('Conversion rate');
    expect(asked.every((url) => !url.includes('goal='))).toBe(true);
  });

  it('drops a goal the site does not have, and says so', async () => {
    const asked = serveWithGoal();
    window.history.replaceState(null, '', '/s_test?goal=g_deleted');
    render(show({ goals: [GOAL] }));
    await totalsLanded();

    expect(screen.getByText('That goal no longer exists.')).toBeInTheDocument();
    expect(asked.every((url) => !url.includes('goal='))).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Stop showing this goal' }));
    expect(window.location.search).toBe('');
    expect(screen.queryByText('That goal no longer exists.')).toBeNull();
  });

  it('chooses a goal from the range bar and carries it in the link', async () => {
    serveWithGoal();
    render(show({ goals: [GOAL] }));
    await totalsLanded();

    await userEvent.click(screen.getByRole('button', { name: /^Goal/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Signed up/ }));
    expect(new URLSearchParams(window.location.search).get('goal')).toBe('g_signup');
  });
});
