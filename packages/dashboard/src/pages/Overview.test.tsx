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
                previous: null,
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

function show(): JSX.Element {
  const client = createClient({ fetch: globalThis.fetch });
  const value: AppContextValue = { client, me: { actor: { kind: 'session', id: 'u_1' }, user: null, sites: [SITE] }, site: SITE, now: NOW };
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
describe('Overview, while it loads', () => {
  it('holds open exactly the height the chart will be', async () => {
    serve();
    const { container } = render(show());
    // The chart's own, not the tiles': every skeleton on this page is the
    // height of what it stands in for, and this is the one that was wrong.
    const skeleton = container.querySelector('[class*="chartPanel"] [class*="skeleton"]');
    expect(skeleton).not.toBeNull();
    expect((skeleton as HTMLElement).style.height).toBe(`${CHART_HEIGHT}px`);
    await totalsLanded();
  });
});
