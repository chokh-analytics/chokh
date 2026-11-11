import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { Route } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverageResult, ErrorsResult, VitalsResult } from '@chokh/store/health';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { formatLastSeen, formatVital } from '../lib/format.js';
import { createQueryClient } from '../lib/queries.js';
import { Health, healthWindow } from './Health.js';

// The Health page (AN-VIT01): its own windows on the site's calendar, each p75
// in its own unit written once, every band said with a word and a shape as well
// as a colour, a figure behind too few samples said to be so, the errors with
// the day they were seen, the empty states that say what to do, and coverage's
// reasons for having no number.

// Friday 18 September 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const SITE = {
  id: 's_test',
  name: 'Test',
  domains: ['test.example'],
  teamId: 'default',
  settings: {
    ipMode: 'full' as const,
    visitorIdMode: 'persistent' as const,
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

function ok(data: unknown, meta: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: true, data, meta }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fail(): Response {
  return new Response(
    JSON.stringify({ success: false, error: { code: 'RANGE_TOO_LONG', message: 'Too long' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

const none = { p75: null, samples: 0, rating: null };

function vitals(): VitalsResult {
  return {
    minSamples: 20,
    sort: 'LCP',
    metrics: [
      {
        metric: 'LCP',
        p75: 2510,
        samples: 1200,
        rating: 'needs-improvement',
        shares: { good: 0.7, needsImprovement: 0.2, poor: 0.1 },
        devices: [
          { device: 'desktop', p75: 1900, samples: 800, rating: 'good' },
          { device: 'mobile', p75: 4100, samples: 390, rating: 'poor' },
          { device: 'tablet', p75: null, samples: 10, rating: null },
        ],
      },
      {
        metric: 'INP',
        p75: 180,
        samples: 900,
        rating: 'good',
        shares: { good: 0.8, needsImprovement: 0.15, poor: 0.05 },
        devices: [],
      },
      {
        metric: 'CLS',
        p75: 0.11,
        samples: 1100,
        rating: 'needs-improvement',
        shares: { good: 0.74, needsImprovement: 0.2, poor: 0.06 },
        devices: [],
      },
      { metric: 'FCP', ...none, shares: null, devices: [] },
      { metric: 'TTFB', p75: null, samples: 12, rating: null, shares: null, devices: [] },
    ],
    pages: [
      {
        page: '/courses/:slug',
        samples: 400,
        metrics: {
          LCP: { p75: 4100, samples: 400, rating: 'poor' },
          CLS: { p75: 0.02, samples: 380, rating: 'good' },
        },
      },
      { page: '/rare', samples: 4, metrics: { LCP: { p75: null, samples: 4, rating: null } } },
    ],
    pagesTotal: 2,
    rawOnly: true,
  };
}

function errors(): ErrorsResult {
  return {
    total: 12,
    visitors: 5,
    groupsTotal: 1,
    groups: [
      {
        message: 'TypeError: a is undefined',
        count: 12,
        visitors: 5,
        firstSeen: NOW - 5 * DAY,
        lastSeen: NOW - 2 * DAY,
        pages: [{ page: '/checkout', count: 10 }],
        browsers: [{ browser: 'Safari', count: 12 }],
        sample: {
          at: NOW - 2 * DAY,
          page: '/checkout',
          browser: 'Safari',
          frame: 'https://test.example/app.js:10:4',
          stack: 'TypeError: a is undefined\n    at pay (https://test.example/app.js:10:4)',
        },
      },
    ],
    rawOnly: true,
  };
}

function coverage(over: Partial<CoverageResult> = {}): CoverageResult {
  return {
    state: 'ok',
    people: 40,
    seenInBrowser: 34,
    serverOnly: 6,
    share: 0.15,
    browserIdentified: 50,
    minPeople: 20,
    rawOnly: true,
    ...over,
  };
}

interface Serve {
  vitals?: () => Response;
  errors?: () => Response;
  coverage?: () => Response;
}

function serve(answers: Serve = {}): ReturnType<typeof vi.fn> {
  const fetch = vi.fn((input: string) => {
    const path = new URL(String(input), 'http://chokh.test').pathname;
    if (path.endsWith('/stats/vitals')) {
      return Promise.resolve((answers.vitals ?? (() => ok(vitals(), { retentionDays: 180 })))());
    }
    if (path.endsWith('/stats/errors')) {
      return Promise.resolve(
        (answers.errors ?? (() => ok(errors(), { retentionDays: 180, errorCapture: true })))(),
      );
    }
    if (path.endsWith('/stats/coverage')) {
      return Promise.resolve((answers.coverage ?? (() => ok(coverage())))());
    }
    return Promise.resolve(ok({}));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
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
        <Route path="/:siteId/health">
          <Health />
        </Route>
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function at(path: string): void {
  window.history.replaceState(null, '', path);
}

function requested(fetch: ReturnType<typeof vi.fn>, ending: string): URL[] {
  return fetch.mock.calls
    .map((call) => new URL(String(call[0]), 'http://chokh.test'))
    .filter((url) => url.pathname.endsWith(ending));
}

beforeEach(() => {
  at('/s_test/health');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('formatVital', () => {
  it('writes each metric in its own unit, once', () => {
    expect(formatVital('LCP', 2510)).toBe('2.51 s');
    expect(formatVital('FCP', 900)).toBe('0.90 s');
    expect(formatVital('TTFB', 1800)).toBe('1.80 s');
    expect(formatVital('INP', 180)).toBe('180 ms');
    expect(formatVital('INP', 1240)).toBe('1,240 ms');
    expect(formatVital('CLS', 0.11)).toBe('0.11');
    expect(formatVital('CLS', 0)).toBe('0.00');
    expect(formatVital('LCP', null)).toBeNull();
  });
});

describe('the window', () => {
  it('ends with the site today and starts on a whole day, 28 days by default', () => {
    expect(healthWindow(NOW, 28, 'UTC')).toEqual({
      from: Date.UTC(2026, 7, 22),
      to: Date.UTC(2026, 8, 19),
    });
    expect(healthWindow(NOW, 7, 'Asia/Dhaka')).toEqual({
      from: Date.UTC(2026, 8, 11, 18),
      to: Date.UTC(2026, 8, 18, 18),
    });
  });
});

describe('Page speed', () => {
  it('draws each core vital with its unit, its band in words and its device split', async () => {
    const fetch = serve();
    render(show());
    const lcp = await screen.findByRole('region', { name: 'Largest Contentful Paint' });
    expect(within(lcp).getByText('2.51 s')).toBeInTheDocument();
    // The band is a word beside its shape, not a colour alone.
    expect(within(lcp).getAllByText('Needs improvement').length).toBeGreaterThan(0);
    expect(within(lcp).getByText('From 1,200 page loads')).toBeInTheDocument();
    expect(within(lcp).getByText('70%')).toBeInTheDocument();
    const devices = within(lcp).getByRole('list', { name: 'By device' });
    expect(within(devices).getByText('4.10 s')).toBeInTheDocument();
    expect(within(devices).getByText('Too few samples (10) for a number')).toBeInTheDocument();
    const inp = screen.getByRole('region', { name: 'Interaction to Next Paint' });
    expect(within(inp).getByText('180 ms')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Cumulative Layout Shift' })).getByText('0.11')).toBeInTheDocument();
    // A supporting timing with a handful of samples says so; one never measured says that.
    expect(
      within(screen.getByRole('region', { name: 'Time to First Byte' })).getByText(
        'Too few samples (12) for a number',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'First Contentful Paint' })).getByText(
        'Not measured in this window',
      ),
    ).toBeInTheDocument();
    const [url] = requested(fetch, '/stats/vitals');
    expect(url?.searchParams.get('from')).toBe(String(Date.UTC(2026, 7, 22)));
    expect(url?.searchParams.get('sort')).toBe('LCP');
    expect(url?.searchParams.has('device')).toBe(false);
  });

  it('lists the slow pages with too few said in words, and sorts and filters from the keyboard', async () => {
    const fetch = serve();
    const user = userEvent.setup();
    render(show());
    const table = await screen.findByRole('table', { name: /Pages by their 75th percentile/ });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('/courses/:slug')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('4.10 s')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Poor')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Too few')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'CLS' }));
    await waitFor(() => expect(window.location.search).toContain('sort=CLS'));
    await user.click(screen.getByRole('radio', { name: 'Mobile' }));
    await waitFor(() => {
      const last = requested(fetch, '/stats/vitals').at(-1);
      expect(last?.searchParams.get('device')).toBe('mobile');
      expect(last?.searchParams.get('sort')).toBe('CLS');
    });
  });

  it('says how to start measuring when nothing was measured', async () => {
    serve({
      vitals: () =>
        ok({ ...vitals(), metrics: vitals().metrics.map((each) => ({ ...each, ...none, shares: null, devices: [] })), pages: [], pagesTotal: 0 }),
    });
    render(show());
    expect(await screen.findByText(/No page speed was measured in this window/)).toBeInTheDocument();
    expect(screen.getAllByText(/v\.js"><\/script>/).length).toBeGreaterThan(0);
  });

  it('draws an error with a retry on a failed read', async () => {
    serve({ vitals: fail });
    render(show());
    expect((await screen.findAllByRole('alert')).some((node) => node.textContent?.includes('Too long'))).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });
});

describe('Errors', () => {
  it('lists the groups with the day they were seen and opens one to its sample', async () => {
    serve();
    const user = userEvent.setup();
    at('/s_test/health?view=errors');
    render(show());
    const summary = await screen.findByText('TypeError: a is undefined');
    expect(screen.getByText('12 times')).toBeInTheDocument();
    expect(screen.getByText('5 people')).toBeInTheDocument();
    // Two days ago, so the list says which day rather than a bare clock time.
    expect(screen.getByText(`Last seen ${formatLastSeen(NOW - 2 * DAY, NOW, 'UTC')}`)).toBeInTheDocument();
    expect(formatLastSeen(NOW - 2 * DAY, NOW, 'UTC')).toMatch(/16 Sept?/);
    await user.click(summary);
    expect(screen.getByText('https://test.example/app.js:10:4')).toBeVisible();
    expect(screen.getByLabelText('Stack trace')).toHaveTextContent('at pay');
  });

  it('says capture is off and where to turn it on, rather than that nothing broke', async () => {
    serve({ errors: () => ok({ ...errors(), total: 0, visitors: 0, groups: [], groupsTotal: 0 }, { errorCapture: false }) });
    at('/s_test/health?view=errors');
    render(show());
    expect(await screen.findByText(/Error capture is off for this site/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/s_test/settings');
  });

  it('says nothing broke when capture is on and the window is clean', async () => {
    serve({ errors: () => ok({ ...errors(), total: 0, visitors: 0, groups: [], groupsTotal: 0 }, { errorCapture: true }) });
    at('/s_test/health?view=errors');
    render(show());
    expect(await screen.findByText('No JavaScript errors in this window.')).toBeInTheDocument();
  });
});

describe('Coverage', () => {
  it('writes the share once as a percentage with the counts behind it', async () => {
    serve();
    at('/s_test/health?view=coverage');
    render(show());
    expect(await screen.findByText('15%')).toBeInTheDocument();
    expect(
      screen.getByText('6 of the 40 people your server named in this window were never seen by the tracker.'),
    ).toBeInTheDocument();
  });

  it('says why there is no number for a site that sends no server events', async () => {
    serve({ coverage: () => ok(coverage({ state: 'no_server_events', people: 0, seenInBrowser: 0, serverOnly: 0, share: null })) });
    at('/s_test/health?view=coverage');
    render(show());
    expect(await screen.findByText(/this site sends no server events/)).toBeInTheDocument();
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it('gives the counts and no share when there are too few people', async () => {
    serve({ coverage: () => ok(coverage({ state: 'too_few', people: 5, seenInBrowser: 3, serverOnly: 2, share: null })) });
    at('/s_test/health?view=coverage');
    render(show());
    expect(await screen.findByText('Too few people for an estimate yet.')).toBeInTheDocument();
    expect(screen.getByText(/2 of 5 people your server named/)).toBeInTheDocument();
  });
});

describe('the views', () => {
  it('moves between the views and windows from the keyboard, in the address bar', async () => {
    const fetch = serve();
    const user = userEvent.setup();
    render(show());
    await screen.findByRole('region', { name: 'Largest Contentful Paint' });
    screen.getByRole('tab', { name: 'Errors' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.location.search).toContain('view=errors'));
    await user.click(screen.getByRole('radio', { name: 'Last 90 days' }));
    await waitFor(() => expect(window.location.search).toContain('window=90'));
    await waitFor(() => {
      const last = requested(fetch, '/stats/errors').at(-1);
      expect(last?.searchParams.get('from')).toBe(String(Date.UTC(2026, 5, 21)));
    });
  });
});
