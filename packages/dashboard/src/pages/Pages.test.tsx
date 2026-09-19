import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Pages } from './Pages.js';

// The two cards on this report that are about what cannot be measured.
//
// A page is only finished when somebody leaves it, so a page nobody has closed
// has no time on page and no scroll depth. Drawing that as "0s" and an empty
// bar says people opened it and read nothing, which is the opposite of what
// happened. And Chokh never sees a status code, so the 404 card says what the
// convention is rather than guessing from paths or quietly not existing.

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
    retentionDays: 90,
    timezone: 'UTC',
    allowUnsignedIdentify: false,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
  },
};

function metrics(visitors: number) {
  return {
    visitors,
    pageviews: visitors * 2,
    visits: visitors,
    bounces: 1,
    bounceRate: 0.2,
    avgDurationMs: 30_000,
  };
}

function ok(data: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
  } as unknown as Response;
}

interface Routes {
  engagement?: () => Response;
  events?: () => Response;
}

function serve(routes: Routes = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname.endsWith('/stats/engagement')) {
        return Promise.resolve(
          (routes.engagement ??
            (() =>
              ok({
                dim: 'page',
                rawOnly: true,
                rows: [
                  { key: '/read', avgTimeOnPageMs: 92_000, avgScrollDepth: 0.75, leaves: 40 },
                ],
              })))(),
        );
      }
      const dim = url.searchParams.get('dim') ?? '';
      if (dim === 'event') {
        return Promise.resolve((routes.events ?? (() => ok({ dim, rows: [] })))());
      }
      return Promise.resolve(ok({ dim, rows: [{ key: '/read', metrics: metrics(100) }] }));
    }),
  );
}

function show(): JSX.Element {
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: { actor: { kind: 'session', id: 'u_1' }, user: null, sites: [SITE], teams: [] },
    site: SITE,
    now: NOW,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Pages />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/pages');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Pages', () => {
  it('shows how far people read, and how many exits it was measured over', async () => {
    serve();
    render(show());

    const engagement = await screen.findByRole('region', { name: 'How far people read' });
    await waitFor(() => expect(within(engagement).getByText('1m 32s')).toBeInTheDocument());
    expect(within(engagement).getByText('75%')).toBeInTheDocument();
    expect(within(engagement).getByText('40')).toBeInTheDocument();
  });

  // Nobody has closed this page yet. A zero here would be a measurement nobody
  // made.
  it('says a page nobody has left has no number rather than a zero', async () => {
    serve({
      engagement: () =>
        ok({
          dim: 'page',
          rawOnly: true,
          rows: [{ key: '/new', avgTimeOnPageMs: null, avgScrollDepth: null, leaves: 0 }],
        }),
    });
    render(show());

    const engagement = await screen.findByRole('region', { name: 'How far people read' });
    await waitFor(() =>
      expect(within(engagement).getAllByText('not available')).toHaveLength(2),
    );
    expect(within(engagement).queryByText('0s')).toBeNull();
    expect(within(engagement).queryByText('0%')).toBeNull();
  });

  // Leaves are raw rows, so this report sees only as far back as the site keeps
  // them. Saying so is the difference between an empty card and a card somebody
  // can act on.
  it('says how far back the engagement numbers can see', async () => {
    serve();
    render(show());

    const engagement = await screen.findByRole('region', { name: 'How far people read' });
    expect(within(engagement).getByText(/90 days/)).toBeInTheDocument();
  });

  it('explains the 404 convention when nobody has sent the event', async () => {
    serve();
    render(show());

    const notFound = await screen.findByRole('region', { name: 'Pages that were not found' });
    await waitFor(() =>
      expect(within(notFound).getByText('No 404 events in this range.')).toBeInTheDocument(),
    );
    expect(within(notFound).getByText(/chokh\.event\("404"/)).toBeInTheDocument();
  });

  it('counts the 404 event when somebody has sent it', async () => {
    serve({
      events: () =>
        ok({
          dim: 'event',
          rows: [
            { key: '404', metrics: metrics(7) },
            { key: 'signup', metrics: metrics(3) },
          ],
        }),
    });
    render(show());

    const notFound = await screen.findByRole('region', { name: 'Pages that were not found' });
    // Seven visitors, fourteen pageviews: a 404 is counted per hit, because
    // three people hitting the same dead link three times is nine mistakes.
    await waitFor(() => expect(within(notFound).getByText('14')).toBeInTheDocument());
    expect(within(notFound).queryByText('No 404 events in this range.')).toBeNull();
  });
});
