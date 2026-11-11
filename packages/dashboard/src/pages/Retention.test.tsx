import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { Route } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityResult,
  AttributionResult,
  CohortResult,
  PowerUsersResult,
} from '@chokh/store/contract';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { formatLastSeen } from '../lib/format.js';
import { createQueryClient } from '../lib/queries.js';
import { bandOf, cohortWindow, daysWindow, Retention } from './Retention.js';

// The retention page (AN-PPL01): its own windows on the site's calendar, a
// cohort grid that says which bucket is still running, rates written once as a
// percentage, names only for a caller allowed them, and attribution that says
// what to do when there is no goal yet.

// Friday 18 September 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// Monday 14 September, the running week.
const THIS_WEEK = Date.UTC(2026, 8, 14);

function siteWith(visitorIdMode: 'persistent' | 'cookieless' = 'persistent') {
  return {
    id: 's_test',
    name: 'Test',
    domains: ['test.example'],
    teamId: 'default',
    settings: {
      ipMode: 'full' as const,
      visitorIdMode,
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
}

function ok(data: unknown, meta: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: true, data, meta }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function cohorts(): CohortResult {
  const week = (start: number, visitors: number, counts: number[]) => ({
    start,
    end: start + WEEK,
    visitors,
    periods: counts.map((count, index) => ({
      start: start + index * WEEK,
      end: start + (index + 1) * WEEK,
      visitors: count,
      rate: visitors === 0 ? null : count / visitors,
      complete: start + (index + 1) * WEEK <= NOW,
    })),
  });
  return {
    interval: 'week',
    cohorts: [
      week(THIS_WEEK - 2 * WEEK, 4, [4, 2, 1]),
      week(THIS_WEEK - WEEK, 0, [0, 0]),
      week(THIS_WEEK, 2, [2]),
    ],
    rawOnly: true,
  };
}

function activity(): ActivityResult {
  const days = Array.from({ length: 30 }, (_, index) => {
    const start = Date.UTC(2026, 7, 20) + index * DAY;
    return { start, end: start + DAY, dau: 4, wau: 10, mau: 16, complete: index < 29 };
  });
  return {
    days,
    dau: 4,
    wau: 10,
    mau: 16,
    stickiness: 0.25,
    visitors: 20,
    returning: 15,
    returningRate: 0.75,
    curve: [8, 5, 3, 2, 1, 1, ...new Array<number>(24).fill(0)],
    powerMinDays: 10,
    powerUsers: 0,
    rawOnly: true,
  };
}

function powerUsers(): PowerUsersResult {
  return {
    people: [
      {
        visitorId: 'v_ada_123456789',
        userId: 'u_ada',
        traits: { name: 'Ada Lovelace' },
        firstSeenAt: NOW - 40 * DAY,
        // Three days ago, so the list has to say which day.
        lastSeenAt: NOW - 3 * DAY,
        sessions: 31,
        pageviews: 90,
        devices: ['Chrome on Windows'],
        ips: ['203.0.113.7'],
        activeDays: 12,
        visits: 14,
      },
    ],
    days: 30,
    minDays: 10,
    rawOnly: true,
  };
}

function attribution(): AttributionResult {
  return {
    dim: 'channel',
    visitors: 4,
    completions: 6,
    value: null,
    rows: [
      {
        key: 'email',
        first: { visitors: 3, completions: 4 },
        last: { visitors: 1, completions: 1 },
      },
      { key: '', first: { visitors: 1, completions: 2 }, last: { visitors: 3, completions: 5 } },
    ],
    other: { first: { visitors: 0, completions: 0 }, last: { visitors: 0, completions: 0 } },
    rawOnly: true,
  };
}

const GOAL = {
  siteId: 's_test',
  id: 'g_signup',
  kind: 'event',
  match: 'signup',
  name: 'Signed up',
  createdBy: 'u_1',
  createdAt: NOW - 10 * DAY,
};

interface Serve {
  cohorts?: () => Response;
  activity?: () => Response;
  power?: () => Response;
  attribution?: () => Response;
  goals?: unknown[];
}

function serve(answers: Serve = {}): ReturnType<typeof vi.fn> {
  const fetch = vi.fn((input: string) => {
    const url = new URL(String(input), 'http://chokh.test');
    const path = url.pathname;
    if (path.endsWith('/stats/cohorts')) return Promise.resolve((answers.cohorts ?? (() => ok(cohorts(), { retentionDays: 180 })))());
    if (path.endsWith('/stats/activity')) return Promise.resolve((answers.activity ?? (() => ok(activity())))());
    if (path.endsWith('/stats/power-users')) {
      return Promise.resolve((answers.power ?? (() => ok(powerUsers(), { identity: true })))());
    }
    if (path.endsWith('/stats/attribution')) {
      return Promise.resolve((answers.attribution ?? (() => ok(attribution(), { retentionDays: 180 })))());
    }
    if (path.endsWith('/goals')) return Promise.resolve(ok({ goals: answers.goals ?? [GOAL] }));
    return Promise.resolve(ok({}));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function show(site = siteWith()): JSX.Element {
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: { actor: { kind: 'session', id: 'u_1' }, user: null, sites: [site], teams: [] },
    site,
    now: NOW,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Route path="/:siteId/retention">
          <Retention />
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
  at('/s_test/retention');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the windows', () => {
  it('end with the site today and start on whole days and whole weeks', () => {
    const end = Date.UTC(2026, 8, 19);
    expect(daysWindow(NOW, 30, 'UTC')).toEqual({ from: Date.UTC(2026, 7, 20), to: end });
    expect(cohortWindow(NOW, 'week', 'UTC')).toEqual({ from: THIS_WEEK - 11 * WEEK, to: end });
    expect(cohortWindow(NOW, 'month', 'UTC')).toEqual({ from: Date.UTC(2026, 3, 1), to: end });
    // In Dhaka it is already 18:00 on the 18th; the day starts at 18:00 UTC.
    expect(daysWindow(NOW, 1, 'Asia/Dhaka')).toEqual({
      from: Date.UTC(2026, 8, 17, 18),
      to: Date.UTC(2026, 8, 18, 18),
    });
  });

  it('shades by band and leaves nothing and nobody unshaded', () => {
    expect([null, 0, 0.05, 0.2, 0.4, 0.7, 1].map(bandOf)).toEqual([-1, -1, 0, 1, 2, 3, 4]);
  });
});

describe('Cohorts', () => {
  it('draws the grid with each rate written once and the running week marked', async () => {
    const fetch = serve();
    render(show());
    const grid = await screen.findByRole('table', { name: /Cohorts by when people were first seen/ });
    expect(within(grid).getByText('31 Aug')).toBeInTheDocument();
    expect(within(grid).getByText('Week 2')).toBeInTheDocument();
    // 2 of 4, 1 of 4: written as 50% and 25%, never 0.5% or 5000%.
    expect(within(grid).getByText('50%')).toBeInTheDocument();
    expect(within(grid).getByText('25%')).toBeInTheDocument();
    expect(within(grid).getAllByText(/still running/).length).toBeGreaterThan(0);
    expect(screen.getByText(/180 days/)).toBeInTheDocument();
    const [url] = requested(fetch, '/stats/cohorts');
    expect(url?.searchParams.get('interval')).toBe('week');
    expect(url?.searchParams.get('from')).toBe(String(THIS_WEEK - 11 * WEEK));
    expect(url?.searchParams.has('filters')).toBe(false);
  });

  it('switches to months from the keyboard and keeps the choice in the address bar', async () => {
    const fetch = serve();
    render(show());
    await screen.findByRole('table', { name: /Cohorts/ });
    const monthly = screen.getByRole('radio', { name: 'Monthly' });
    monthly.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(requested(fetch, '/stats/cohorts').some((url) => url.searchParams.get('interval') === 'month')).toBe(true),
    );
    expect(window.location.search).toContain('interval=month');
    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true');
  });

  it('says so when nobody is new, and offers a retry when the read fails', async () => {
    serve({ cohorts: () => ok({ interval: 'week', cohorts: [], rawOnly: true }) });
    const first = render(show());
    expect(await screen.findByText(/Nobody was first seen in this window yet/)).toBeInTheDocument();
    first.unmount();
    serve({
      cohorts: () =>
        new Response(JSON.stringify({ success: false, error: { code: 'RANGE_TOO_LONG', message: 'Too long' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    });
    render(show());
    expect(await screen.findByRole('alert')).toHaveTextContent('Too long');
  });

  it('says why nobody comes back on a site with cookieless ids', async () => {
    serve();
    render(show(siteWith('cookieless')));
    expect(await screen.findByText(/new id every day/)).toBeInTheDocument();
  });
});

describe('Activity', () => {
  beforeEach(() => {
    at('/s_test/retention?view=activity');
  });

  it('shows the averages, stickiness and returning as percentages, and the curve', async () => {
    const fetch = serve();
    render(show());
    expect(await screen.findByText('25%')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    const tiles = screen.getAllByRole('button', { name: /Monthly active/ });
    expect(tiles.some((tile) => tile.textContent?.includes('16') === true)).toBe(true);
    expect(screen.getByRole('table', { name: /number of days they were active/ })).toBeInTheDocument();
    const [url] = requested(fetch, '/stats/activity');
    expect(url?.searchParams.get('from')).toBe(String(Date.UTC(2026, 7, 20)));
    // The window ends with today, not this minute, so the key holds all day.
    expect(url?.searchParams.get('to')).toBe(String(Date.UTC(2026, 8, 19)));
  });

  it('names the most active people with the day they were last seen', async () => {
    serve();
    render(show());
    const list = await screen.findByRole('table', { name: /most active people/ });
    expect(within(list).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(list).getByText('12 of 30')).toBeInTheDocument();
    expect(within(list).getByText(formatLastSeen(NOW - 3 * DAY, NOW, 'UTC'))).toBeInTheDocument();
    expect(formatLastSeen(NOW - 3 * DAY, NOW, 'UTC')).toMatch(/^15 Sep/);
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/s_test/people/v/v_ada_123456789');
  });

  it('names nobody for a caller without read:identity', async () => {
    const stripped = powerUsers();
    const { userId: _userId, traits: _traits, ...rest } = stripped.people[0]!;
    serve({ power: () => ok({ ...stripped, people: [{ ...rest, ips: [] }] }, { identity: false }) });
    render(show());
    const list = await screen.findByRole('table', { name: /most active people/ });
    expect(within(list).queryByText('Ada Lovelace')).toBeNull();
    expect(within(list).getByText('Visitor')).toBeInTheDocument();
  });

  it('reads ninety days when asked', async () => {
    const fetch = serve();
    render(show());
    await screen.findByText('25%');
    await userEvent.click(screen.getByRole('radio', { name: 'Last 90 days' }));
    await waitFor(() =>
      expect(
        requested(fetch, '/stats/activity').some(
          (url) => url.searchParams.get('from') === String(Date.UTC(2026, 5, 21)),
        ),
      ).toBe(true),
    );
  });
});

describe('Attribution', () => {
  beforeEach(() => {
    at('/s_test/retention?view=attribution');
  });

  it('splits the first goal by channel, the empty key read as none recorded', async () => {
    const fetch = serve();
    render(show());
    const table = await screen.findByRole('table', { name: /by first touch and by last touch/ });
    expect(within(table).getByText('None recorded')).toBeInTheDocument();
    expect(within(table).getByText('Email')).toBeInTheDocument();
    // 3 of 4 people: 75%, written once.
    expect(within(table).getAllByText('75%').length).toBe(2);
    expect(screen.getByText('4 people converted, 6 times')).toBeInTheDocument();
    const [url] = requested(fetch, '/stats/attribution');
    expect(url?.searchParams.get('goal')).toBe('g_signup');
    expect(url?.searchParams.get('dim')).toBe('channel');
  });

  it('splits by another dimension when chosen', async () => {
    const fetch = serve();
    render(show());
    await screen.findByRole('table', { name: /first touch/ });
    await userEvent.selectOptions(screen.getByLabelText('Split by'), 'utm_source');
    await waitFor(() =>
      expect(
        requested(fetch, '/stats/attribution').some((url) => url.searchParams.get('dim') === 'utm_source'),
      ).toBe(true),
    );
    expect(window.location.search).toContain('split=utm_source');
  });

  it('says a goal is needed, and where to add one, when there is none', async () => {
    const fetch = serve({ goals: [] });
    render(show());
    expect(await screen.findByText(/has no goal yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a goal' })).toBeInTheDocument();
    expect(requested(fetch, '/stats/attribution')).toEqual([]);
  });
});
