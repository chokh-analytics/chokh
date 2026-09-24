import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { DimensionCard } from './DimensionCard.js';

// The card every report after the Overview is made of.
//
// Three of these cases are about the ranking rather than about React. A bar
// with no scale on it is decoration, so the top row fills its cell and the rest
// are drawn against it. A tab that remembered "show more" would carry a
// decision about one list into a different list. And a row for a dimension the
// store cannot filter by must not look pressable, because a row that highlights
// and does nothing is worse than a row that never invited the press.

const NOW = Date.UTC(2026, 8, 20, 9, 0, 0);

const SITE = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
  teamId: 'default',
  settings: {
    ipMode: 'anonymized' as const,
    visitorIdMode: 'cookieless' as const,
    botFilter: true,
    retentionDays: 180,
    timezone: 'UTC',
    allowUnsignedIdentify: false,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
    routeGroups: [],
  },
};

function metrics(visitors: number) {
  return {
    visitors,
    pageviews: visitors * 2,
    visits: visitors,
    bounces: 0,
    bounceRate: 0.25,
    avgDurationMs: 60_000,
  };
}

// Twelve rows, so ten are drawn and the eleventh proves there is more.
function rowsFor(dim: string, count = 12) {
  return Array.from({ length: count }, (_row, index) => ({
    key: dim === 'country' ? ['BD', 'IN', 'GB', 'US'][index % 4] + String(index) : `/p${index}`,
    metrics: metrics(1000 - index * 10),
  }));
}

function ok(data: unknown, meta?: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data, meta }),
  } as unknown as Response;
}

function serve(count = 12): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn((input: string) => {
    const dim = new URL(String(input), 'http://x').searchParams.get('dim') ?? '';
    const limit = Number(new URL(String(input), 'http://x').searchParams.get('limit') ?? '0');
    return Promise.resolve(ok({ dim, rows: rowsFor(dim, count).slice(0, limit) }));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const TABS = [
  { id: 'all', dim: 'page' as const, label: 'All pages' },
  { id: 'entry', dim: 'entry' as const, label: 'Entry' },
];

function show(node: JSX.Element, over: Partial<AppContextValue> = {}): JSX.Element {
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: { actor: { kind: 'session', id: 'u_1' }, user: null, sites: [SITE], teams: [] },
    site: SITE,
    now: NOW,
    ...over,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>{node}</AppContext.Provider>
    </QueryClientProvider>
  );
}

function card(): HTMLElement {
  return screen.getByRole('region', { name: 'Top pages' });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/pages');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DimensionCard', () => {
  it('draws ten rows and offers the rest', async () => {
    serve();
    render(show(<DimensionCard title="Top pages" tabs={TABS} param="pages" />));

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    expect(within(card()).queryByText('/p9')).toBeInTheDocument();
    expect(within(card()).queryByText('/p10')).toBeNull();
    expect(screen.getByRole('button', { name: /Show up to 100/ })).toBeInTheDocument();
  });

  it('offers nothing more when ten rows are all there is', async () => {
    serve(10);
    render(show(<DimensionCard title="Top pages" tabs={TABS} param="pages" />));

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Show up to/ })).toBeNull();
  });

  // The bar is a ranking, and a ranking with no scale on it is decoration. The
  // top row fills the cell and a row with half its visitors fills half, so the
  // picture and the numbers beside it say the same thing.
  it('draws each bar against the top row of the report', async () => {
    serve(12);
    render(show(<DimensionCard title="Top pages" tabs={TABS} param="pages" />));

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    const widthOf = (label: string): string => {
      const row = within(card()).getByText(label).closest('tr');
      return (row?.querySelector('[class*="bar"]') as HTMLElement | null)?.style.width ?? '';
    };

    // 1000, 990, ... 910: the first is the scale and the tenth is 91% of it.
    expect(widthOf('/p0')).toBe('100%');
    expect(widthOf('/p9')).toBe('91%');
  });

  it('puts the open tab in the URL and goes back to ten rows with it', async () => {
    serve(40);
    render(show(<DimensionCard title="Top pages" tabs={TABS} param="pages" />));

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Show up to 100/ }));
    await waitFor(() => expect(within(card()).getByText('/p20')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: 'Entry' }));

    expect(window.location.search).toBe('?pages=entry');
    await waitFor(() => expect(within(card()).queryByText('/p20')).toBeNull());
    expect(screen.getByRole('button', { name: /Show up to 100/ })).toBeInTheDocument();
  });

  // The URL carries the range and the filters on screen, so what a person
  // downloads is what they were reading rather than the site's whole history.
  it('offers the rows on screen as a file, for the range on screen', async () => {
    serve();
    window.history.replaceState(null, '', '/s_test/pages?range=30d');
    render(show(<DimensionCard title="Top pages" tabs={TABS} param="pages" />));

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    const download = within(card()).getByRole('link', { name: 'Download CSV' });
    const href = download.getAttribute('href') ?? '';
    expect(href).toContain('/export.csv');
    expect(href).toContain('dim=page');
    expect(download).toHaveAttribute('download');
  });

  it('carries a note where the card has one to make', async () => {
    serve();
    render(
      show(
        <DimensionCard title="Top pages" tabs={TABS} param="pages" note="A thing worth saying." />,
      ),
    );

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    expect(within(card()).getByText('A thing worth saying.')).toBeInTheDocument();
  });

  // Every other analytics tool files a visit sent by ChatGPT under referral or
  // under search. Filing it as neither is this product's own reading of the
  // web, and a claim like that gets a mark on the row that makes it rather than
  // a line in a changelog nobody reads.
  it('marks the AI channel and marks nothing else', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          ok({
            dim: 'channel',
            rows: [
              { key: 'ai', metrics: metrics(400) },
              { key: 'organic', metrics: metrics(300) },
              { key: '', metrics: metrics(50) },
            ],
          }),
        ),
      ),
    );
    render(
      show(
        <DimensionCard
          title="Channels"
          tabs={[{ id: 'channel', dim: 'channel' as const, label: 'Channel' }]}
          param="channels"
        />,
      ),
    );

    const channels = (): HTMLElement => screen.getByRole('region', { name: 'Channels' });
    await waitFor(() => expect(within(channels()).getByText('AI assistants')).toBeInTheDocument());
    const rowFor = (label: string): HTMLElement => {
      const row = within(channels()).getByText(label).closest('tr');
      if (row === null) {
        throw new Error(`No row around ${label}`);
      }
      return row;
    };
    expect(within(rowFor('AI assistants')).getByText('AI')).toBeInTheDocument();
    expect(within(rowFor('Organic search')).queryByText('AI')).toBeNull();
    expect(within(rowFor('Unknown')).queryByText('AI')).toBeNull();
  });

  // The store narrows a report to the stays that came in on a page, so an
  // entry row is a button like every other row, and pressing it writes the
  // filter into the link with no sentence about what cannot be done.
  it('makes every row pressable, the entry rows included', async () => {
    serve();
    render(show(<DimensionCard title="Top pages" tabs={TABS} param="pages" />));

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    expect(within(card()).getByText('/p0').closest('button')).not.toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'Entry' }));
    await waitFor(() => expect(window.location.search).toBe('?pages=entry'));
    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    expect(within(card()).queryByText(/cannot be filtered/)).toBeNull();
    const row = within(card()).getByText('/p0').closest('button');
    expect(row).not.toBeNull();
    await userEvent.click(row as HTMLElement);
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('filters')).toBe('entry==/p0'),
    );
  });
});

// With a goal chosen the quiet column is the conversion rate, whatever the card
// drew there before, and the rows keep their order: the ranking is visitors.
describe('DimensionCard, with a goal chosen', () => {
  const GOAL = {
    siteId: 's_test',
    id: 'g_signup',
    kind: 'event' as const,
    match: 'signup',
    name: 'Signed up',
    createdBy: 'u_1',
    createdAt: NOW - 86_400_000,
  };

  function serveConverting(): ReturnType<typeof vi.fn> {
    const fetcher = vi.fn((input: string) => {
      const params = new URL(String(input), 'http://x').searchParams;
      const dim = params.get('dim') ?? '';
      const withGoal = params.get('goal') !== null;
      const rows = rowsFor(dim, 3).map((row, index) => ({
        ...row,
        ...(withGoal
          ? {
              conversion: {
                visitors: 100 - index * 40,
                completions: 120,
                rate: index === 2 ? null : (100 - index * 40) / row.metrics.visitors,
                value: null,
              },
            }
          : {}),
      }));
      return Promise.resolve(
        ok({ dim, rows }, withGoal ? { retentionDays: 120, rawOnly: true } : undefined),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it('draws the rate with how many people it is, and the raw events note', async () => {
    const fetcher = serveConverting();
    window.history.replaceState(null, '', '/s_test/pages?goal=g_signup');
    render(show(<DimensionCard title="Top pages" tabs={TABS} param="pages" />, { goals: [GOAL] }));

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    expect(within(card()).getByRole('columnheader', { name: 'Conversion rate' })).toBeInTheDocument();
    expect(within(card()).queryByRole('columnheader', { name: 'Pageviews' })).toBeNull();

    // 100 of 1,000 is 10%, and hovering says who that is.
    const rate = within(card()).getByText('10%');
    expect(rate).toHaveAttribute('title', '100 converted');
    // A row over nobody has no rate rather than a zero.
    const third = within(card()).getByText('/p2').closest('tr');
    expect(third).toHaveTextContent('not available');

    expect(
      within(card()).getByText('Read from raw events, so this report sees back 120 days and no further.'),
    ).toBeInTheDocument();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('goal=g_signup');

    // The file carries the goal, so it has the four conversion columns too.
    const href = within(card()).getByRole('link', { name: 'Download CSV' }).getAttribute('href');
    expect(href).toContain('goal=g_signup');
  });

  it('draws the column it always drew, and no note, when no goal is chosen', async () => {
    const fetcher = serveConverting();
    render(show(<DimensionCard title="Top pages" tabs={TABS} param="pages" />, { goals: [GOAL] }));

    await waitFor(() => expect(within(card()).getByText('/p0')).toBeInTheDocument());
    expect(within(card()).getByRole('columnheader', { name: 'Pageviews' })).toBeInTheDocument();
    expect(within(card()).queryByText(/Read from raw events/)).toBeNull();
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('goal=');
    const href = within(card()).getByRole('link', { name: 'Download CSV' }).getAttribute('href');
    expect(href).not.toContain('goal=');
  });
});
