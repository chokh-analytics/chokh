import { finishJourneys, journeyPath, journeyStepCounts, topJourneyPages } from '@chokh/store';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Pages } from './Pages.js';

// Journeys, the fourth tab on Pages: the paths visits took, drawn as four
// columns with bands between them and read as a table underneath.
//
// The answers are built with the store's own path functions from a handful of
// visits, so every node, exit and link on the page is the one the server would
// send for those visits rather than a shape written to fit the component.

const NOW = Date.UTC(2026, 8, 20, 9, 0, 0);

const SITE = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
  teamId: 'default',
  settings: {
    ipMode: 'anonymized' as const,
    visitorIdMode: 'persistent' as const,
    botFilter: true,
    retentionDays: 90,
    timezone: 'UTC',
    allowUnsignedIdentify: false,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
    routeGroups: [],
  },
};

// Eight visits. Four came in on the home page, and one reloaded /docs, which
// is one step and not two.
const VISITS = [
  ['/', '/pricing', '/checkout'],
  ['/', '/pricing'],
  ['/', '/docs', '/pricing', '/checkout', '/done'],
  ['/', '/blog', '/about', '/team', '/jobs', '/contact'],
  ['/docs', '/docs', '/pricing'],
  ['/blog'],
  ['/about'],
  ['/team'],
];

function journeysFor(branches: number, visits: string[][] = VISITS) {
  const paths = visits.map((visit) => journeyPath(visit));
  return finishJourneys(journeyStepCounts(paths, topJourneyPages(paths, branches)), branches);
}

function ok(data: unknown, meta?: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data, meta }),
  } as unknown as Response;
}

function serve(visits: string[][] = VISITS): { journeyReads: () => URL[] } {
  const fetcher = vi.fn((input: string) => {
    const url = new URL(String(input), 'http://x');
    if (url.pathname.endsWith('/stats/journeys')) {
      return Promise.resolve(
        ok(journeysFor(Number(url.searchParams.get('branches') ?? 5), visits), {
          retentionDays: 90,
          rawOnly: true,
        }),
      );
    }
    if (url.pathname.endsWith('/stats/engagement')) {
      return Promise.resolve(ok({ dim: 'page', rawOnly: true, rows: [] }));
    }
    return Promise.resolve(ok({ dim: url.searchParams.get('dim') ?? '', rows: [] }));
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    journeyReads: () =>
      fetcher.mock.calls
        .map(([input]) => new URL(String(input), 'http://x'))
        .filter((url) => url.pathname.endsWith('/stats/journeys')),
  };
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

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

async function flow(): Promise<HTMLElement> {
  return screen.findByRole('group', {
    name: 'The paths visits took, from the page they came in on',
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/pages');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Journeys', () => {
  it('opens as the fourth tab of Top pages, in the link, and draws four columns', async () => {
    const server = serve();
    render(show());

    const card = await screen.findByRole('region', { name: 'Top pages' });
    const tabs = within(card).getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['All pages', 'Routes', 'Entry', 'Exit', 'Journeys']);
    // Nothing is asked for a tab nobody opened.
    expect(server.journeyReads()).toHaveLength(0);

    await userEvent.click(within(card).getByRole('tab', { name: 'Journeys' }));

    expect(params().get('pages')).toBe('journeys');
    const box = await flow();
    for (const head of ['Entry', '2nd page', '3rd page', '4th page']) {
      expect(within(box).getByText(head)).toBeInTheDocument();
    }
    expect(await screen.findByText('8 visits in this range.')).toBeInTheDocument();
    // The home page is where four of the eight came in.
    const home = within(box).getByRole('button', { name: /^\/ 4$/ });
    expect(home).toHaveAttribute('aria-pressed', 'false');
    expect(server.journeyReads()[0]?.searchParams.get('branches')).toBe('5');
    expect(server.journeyReads()[0]?.searchParams.has('goal')).toBe(false);
  });

  it('says how many left at every node, and how many went on past the last', async () => {
    serve();
    window.history.replaceState(null, '', '/s_test/pages?pages=journeys');
    render(show());

    const box = await flow();
    // Two visits ended on /pricing as their second page, and the home page,
    // where four came in, lost nobody before a second page.
    const left = within(box).getAllByText(/left here$/).map((line) => line.textContent);
    expect(left).toContain('2 left here');
    expect(left).toContain('0 left here');
    // Two visits were still going after the fourth page.
    expect(within(box).getAllByText(/went on$/).map((line) => line.textContent)).toContain(
      '1 went on',
    );
  });

  it('folds the rest of a column into Other, which is not a control', async () => {
    const server = serve();
    window.history.replaceState(null, '', '/s_test/pages?pages=journeys&branches=3');
    render(show());

    const box = await flow();
    expect(server.journeyReads()[0]?.searchParams.get('branches')).toBe('3');
    const other = within(box).getAllByText('Other pages')[0] as HTMLElement;
    expect(other.closest('button')).toBeNull();
    // One band per link between two columns, as a picture only.
    const svg = box.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg?.querySelectorAll('path')).toHaveLength(journeysFor(3).links.length);
  });

  it('filters the report from a node and stays on the tab', async () => {
    serve();
    window.history.replaceState(null, '', '/s_test/pages?pages=journeys&range=30d');
    render(show());

    const box = await flow();
    const pricing = within(box).getAllByRole('button', { name: /^\/pricing / })[0] as HTMLElement;
    await userEvent.click(pricing);

    expect(params().get('filters')).toBe('page==/pricing');
    expect(params().get('pages')).toBe('journeys');
    expect(params().get('range')).toBe('30d');
    // Read again under the filter, so the box is found again rather than kept.
    await waitFor(async () =>
      expect(
        within(await flow()).getAllByRole('button', { name: /^\/pricing / })[0],
      ).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('keeps the branch count in the link, the default left out', async () => {
    const server = serve();
    window.history.replaceState(null, '', '/s_test/pages?pages=journeys');
    render(show());
    await flow();

    await userEvent.selectOptions(screen.getByLabelText('Pages per step'), '10');
    expect(params().get('branches')).toBe('10');
    await waitFor(() =>
      expect(server.journeyReads().some((url) => url.searchParams.get('branches') === '10')).toBe(
        true,
      ),
    );

    await userEvent.selectOptions(screen.getByLabelText('Pages per step'), '5');
    expect(params().has('branches')).toBe(false);
  });

  it('reads the same numbers as a table for anybody the picture does not reach', async () => {
    serve();
    window.history.replaceState(null, '', '/s_test/pages?pages=journeys');
    render(show());
    await flow();

    const table = screen.getByRole('table', {
      name: 'The paths as a table: each step, its pages, and where the visits on them went next.',
    });
    const home = within(table)
      .getAllByRole('row')
      .find((row) => row.textContent?.startsWith('Entry/4') === true);
    expect(home, 'no row for the home page as an entry').toBeDefined();
    expect(within(home as HTMLElement).getByText('/pricing: 2')).toBeInTheDocument();
    // The box that scrolls on a phone can be reached and scrolled by a keyboard.
    expect(await flow()).toHaveAttribute('tabindex', '0');
  });

  it('says a range with no page in it has no paths', async () => {
    serve([]);
    window.history.replaceState(null, '', '/s_test/pages?pages=journeys');
    render(show());

    expect(await screen.findByText('No visit in this range viewed a page.')).toBeInTheDocument();
  });

  it('offers to clear the filters when they are why there is nothing', async () => {
    serve([]);
    window.history.replaceState(null, '', '/s_test/pages?pages=journeys&filters=page%3D%3D%2Fnowhere');
    render(show());

    const card = await screen.findByRole('region', { name: 'Top pages' });
    expect(await within(card).findByText('No visitors matched these filters.')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Clear filters' }));
    expect(params().has('filters')).toBe(false);
    expect(params().get('pages')).toBe('journeys');
  });
});
