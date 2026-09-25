import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Share } from './Share.js';

// The shared page (AN-RPT01): the Overview's numbers for whoever holds the
// link, a password when the owner set one, and a plain sentence for a link
// that opens nothing. Every read goes to the share's routes and never to a
// site's.

const NOW = Date.UTC(2026, 8, 25, 4, 0, 0);
const TODAY_START = Date.UTC(2026, 8, 24, 18, 0, 0);

function ok(data: unknown, meta?: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data, meta }),
  } as unknown as Response;
}

function refused(status: number, code: string): Response {
  return {
    status,
    ok: false,
    json: () => Promise.resolve({ success: false, error: { code, message: code } }),
  } as unknown as Response;
}

const metrics = {
  visitors: 315,
  pageviews: 712,
  visits: 306,
  bounces: 92,
  bounceRate: 0.3,
  avgDurationMs: 140_000,
};

interface Head {
  protected: boolean;
  unlocked: boolean;
}

function serve(head: Head | null, unlock: () => Response = () => ok({ unlocked: true })) {
  let current = head;
  const fetcher = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname.startsWith('/api/sites/')) {
      return Promise.resolve(refused(500, 'SITE_ROUTE_ON_A_SHARE'));
    }
    if (url.pathname === '/api/share/tok_1') {
      return Promise.resolve(
        current === null
          ? refused(404, 'UNKNOWN_SHARE')
          : ok({ site: { name: 'Progsity', timezone: 'Asia/Dhaka' }, ...current }),
      );
    }
    if (url.pathname === '/api/share/tok_1/unlock' && method === 'POST') {
      const answer = unlock();
      if (answer.ok && current !== null) {
        current = { ...current, unlocked: true };
      }
      return Promise.resolve(answer);
    }
    if (url.pathname === '/api/share/tok_1/stats/aggregate') {
      return Promise.resolve(
        ok(
          { range: { from: TODAY_START, to: NOW }, metrics, previousRange: null, previous: null },
          { siteId: 's_test', timezone: 'Asia/Dhaka', from: TODAY_START, to: NOW },
        ),
      );
    }
    if (url.pathname === '/api/share/tok_1/stats/timeseries') {
      return Promise.resolve(
        ok({
          interval: 'hour',
          points: [{ start: TODAY_START, end: TODAY_START + 3_600_000, metrics }],
          previous: null,
        }),
      );
    }
    if (url.pathname === '/api/share/tok_1/stats/breakdown') {
      const dim = url.searchParams.get('dim') ?? '';
      const key = { page: '/pricing', channel: 'organic', country: 'BD', device: 'mobile' }[dim] ?? 'x';
      return Promise.resolve(ok({ dim, rows: [{ key, metrics }] }));
    }
    if (url.pathname === '/api/share/tok_1/annotations') {
      return Promise.resolve(ok({ annotations: [] }));
    }
    return Promise.resolve(refused(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function show(): JSX.Element {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <Share client={createClient({ fetch: globalThis.fetch })} token="tok_1" />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  window.history.replaceState(null, '', '/share/tok_1');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the shared page', () => {
  it('draws the numbers, the chart and the four cards for whoever holds the link, and no way to a person', async () => {
    const fetcher = serve({ protected: false, unlocked: true });
    render(show());
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Progsity', level: 1 })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getAllByText('315').length).toBeGreaterThan(0));
    expect(document.title).toBe('Progsity, shared · Chokh');
    expect(screen.getByRole('group', { name: 'Date range' })).toBeInTheDocument();
    for (const name of ['Top pages', 'Sources', 'Countries', 'Devices']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Top pages' })).getByText('/pricing')).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /Powered by Chokh/ })).toHaveAttribute(
      'href',
      'https://github.com/chokh-analytics/chokh',
    );
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: 'People' })).toBeNull();
    // Every read went to the share and none to a site.
    const paths = fetcher.mock.calls.map(([input]) => new URL(String(input), 'http://x').pathname);
    expect(paths.every((path) => path.startsWith('/api/share/tok_1'))).toBe(true);
    expect(paths.some((path) => path.endsWith('/stats/aggregate'))).toBe(true);
    expect(paths.some((path) => path.endsWith('/annotations'))).toBe(true);
  });

  it('says so for a link that opens nothing', async () => {
    serve(null);
    render(show());
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'This link does not open anything.' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('group', { name: 'Date range' })).toBeNull();
  });

  it('stands a password in the way, refuses the wrong one and opens for the right one', async () => {
    let attempts = 0;
    serve({ protected: true, unlocked: false }, () => {
      attempts += 1;
      return attempts === 1 ? refused(401, 'BAD_PASSWORD') : ok({ unlocked: true });
    });
    render(show());
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'This page needs a password' })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Progsity shares its numbers behind a password/)).toBeInTheDocument();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(screen.getByLabelText('Password'), 'wrong-one');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByText('That is not the password.')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'open-sesame');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Progsity', level: 1 })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getAllByText('315').length).toBeGreaterThan(0));
  });
});
