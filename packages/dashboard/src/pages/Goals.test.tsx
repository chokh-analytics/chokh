import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Goals } from './Goals.js';

// The Goals page: what each goal counted, adding one, and taking one away.
//
// The cases that matter most are the two about who may do what and what a
// delete costs. A goal changes what every report of the site says, so only an
// owner adds or removes one, and anybody else is shown the form disabled with
// the reason rather than no form at all. And deleting one loses nothing,
// because a goal is a question asked of the events rather than a counter, which
// the confirmation says at the moment somebody is about to press it.

const NOW = Date.UTC(2026, 8, 20, 9, 0, 0);

const SITE = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
  teamId: 't_own',
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
  },
};

const SIGNUP = {
  siteId: 's_test',
  id: 'g_signup',
  kind: 'event' as const,
  match: 'signup',
  name: 'Signed up',
  value: 2.5,
  createdBy: 'u_1',
  createdAt: NOW - 86_400_000,
};

const CHECKOUT = {
  siteId: 's_test',
  id: 'g_checkout',
  kind: 'page' as const,
  match: '/*/checkout/done',
  name: 'Checked out',
  createdBy: 'u_1',
  createdAt: NOW - 3_600_000,
};

function answer(status: number, body: unknown): Response {
  return { status, ok: status < 400, json: () => Promise.resolve(body) } as unknown as Response;
}

function ok(data: unknown, meta?: unknown): Response {
  return answer(200, { success: true, data, meta });
}

interface Server {
  fetcher: ReturnType<typeof vi.fn>;
  calls: () => { method: string; url: URL; body: unknown }[];
}

function serve(
  goals: (typeof SIGNUP | typeof CHECKOUT)[] = [SIGNUP, CHECKOUT],
  create: () => Response = () => ok({ goal: SIGNUP }),
): Server {
  const fetcher = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/stats/goals')) {
      return Promise.resolve(
        ok(
          {
            visitors: 400,
            rows: goals.map((goal, index) => ({
              goal,
              conversion: {
                visitors: index === 0 ? 38 : 0,
                completions: index === 0 ? 44 : 0,
                rate: index === 0 ? 0.095 : 0,
                value: goal === SIGNUP ? 110 : null,
              },
            })),
            rawOnly: true,
          },
          { retentionDays: 180, rawOnly: true },
        ),
      );
    }
    if (url.pathname.endsWith('/stats/events')) {
      return Promise.resolve(
        ok({
          visitors: 400,
          rows: [
            { key: 'signup', visitors: 40, events: 44, rate: 0.1 },
            { key: 'quiz_start', visitors: 12, events: 20, rate: 0.03 },
          ],
          rawOnly: true,
        }),
      );
    }
    if (url.pathname.endsWith('/goals') && method === 'POST') {
      return Promise.resolve(create());
    }
    if (url.pathname.includes('/goals/') && method === 'DELETE') {
      return Promise.resolve(ok({ deleted: true }));
    }
    return Promise.resolve(ok({ goals }));
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    fetcher,
    calls: () =>
      fetcher.mock.calls.map(([input, init]) => ({
        method: (init as RequestInit | undefined)?.method ?? 'GET',
        url: new URL(String(input), 'http://x'),
        body:
          typeof (init as RequestInit | undefined)?.body === 'string'
            ? JSON.parse((init as RequestInit).body as string)
            : undefined,
      })),
  };
}

function show(role: 'owner' | 'viewer' = 'owner', over: Partial<AppContextValue> = {}): JSX.Element {
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: {
      actor: { kind: 'session', id: 'u_1' },
      user: null,
      sites: [SITE],
      teams: [{ id: 't_own', name: 'Ours', role }],
    },
    site: SITE,
    now: NOW,
    goals: [SIGNUP, CHECKOUT],
    ...over,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Goals />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function list(): HTMLElement {
  return screen.getByRole('region', { name: 'Goals' });
}

function form(): HTMLElement {
  return screen.getByRole('region', { name: 'Add a goal' });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/goals');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Goals, the list', () => {
  it('draws each goal with what it matches and what it counted', async () => {
    serve();
    render(show());

    await waitFor(() => expect(within(list()).getByText('Signed up')).toBeInTheDocument());
    const row = within(list()).getByText('Signed up').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('signup');
    expect(row).toHaveTextContent('38');
    expect(row).toHaveTextContent('9.5%');
    expect(row).toHaveTextContent('44');
    // A plain number, with no unit and no currency.
    expect(row).toHaveTextContent('110');
    expect(row).not.toHaveTextContent(/[$৳]/);

    const other = within(list()).getByText('Checked out').closest('tr') as HTMLElement;
    expect(other).toHaveTextContent('/*/checkout/done');
    // A goal with no value has none, rather than a zero.
    expect(other).toHaveTextContent('not available');
    expect(
      within(list()).getByText('Read from raw events, so this report sees back 180 days and no further.'),
    ).toBeInTheDocument();
  });

  it('chooses a goal from its name and stays on the page', async () => {
    serve();
    render(show());

    await waitFor(() => expect(within(list()).getByText('Signed up')).toBeInTheDocument());
    await userEvent.click(within(list()).getByRole('button', { name: 'Signed up' }));

    expect(window.location.pathname).toBe('/s_test/goals');
    expect(new URLSearchParams(window.location.search).get('goal')).toBe('g_signup');
  });

  it('says there are none yet, and where to add one', async () => {
    serve([]);
    render(show('owner', { goals: [] }));

    expect(await within(list()).findByText('No goals yet.')).toBeInTheDocument();
    expect(
      within(list()).getByText(
        'Add one below and every report can show how many of its visitors reached it.',
      ),
    ).toBeInTheDocument();
  });
});

describe('Goals, adding one', () => {
  it('sends the goal, with its value as a number, and reads the list again', async () => {
    const server = serve();
    render(show());
    await waitFor(() => expect(within(list()).getByText('Signed up')).toBeInTheDocument());
    const before = server.calls().filter((call) => call.url.pathname.endsWith('/stats/goals')).length;

    await userEvent.type(within(form()).getByLabelText('Name'), 'Started a quiz');
    await userEvent.type(within(form()).getByLabelText('Event name'), 'quiz_start');
    await userEvent.type(within(form()).getByLabelText('Value (optional)'), '1.5');
    await userEvent.click(within(form()).getByRole('button', { name: 'Add the goal' }));

    await waitFor(() =>
      expect(server.calls().some((call) => call.method === 'POST')).toBe(true),
    );
    const posted = server.calls().find((call) => call.method === 'POST');
    expect(posted?.url.pathname).toBe('/api/sites/s_test/goals');
    expect(posted?.body).toEqual({
      name: 'Started a quiz',
      kind: 'event',
      match: 'quiz_start',
      value: 1.5,
    });
    await waitFor(() =>
      expect(
        server.calls().filter((call) => call.url.pathname.endsWith('/stats/goals')).length,
      ).toBeGreaterThan(before),
    );
    expect(within(form()).getByLabelText('Name')).toHaveValue('');
  });

  it('offers the event names the site is really sending', async () => {
    serve();
    render(show());

    await waitFor(() =>
      expect(document.querySelectorAll('datalist option')).toHaveLength(2),
    );
    const names = [...document.querySelectorAll('datalist option')].map((option) =>
      option.getAttribute('value'),
    );
    expect(names).toEqual(['signup', 'quiz_start']);
    expect(within(form()).getByLabelText('Event name')).toHaveAttribute('list');
  });

  it('refuses an empty name and a path with no slash before asking the server', async () => {
    const server = serve();
    render(show());

    await userEvent.selectOptions(within(form()).getByLabelText('Counts when'), 'page');
    await userEvent.type(within(form()).getByLabelText('Page path'), 'checkout/done');
    await userEvent.click(within(form()).getByRole('button', { name: 'Add the goal' }));

    expect(within(form()).getByText('This needs a value.')).toBeInTheDocument();
    expect(within(form()).getByText('A path starts with /.')).toBeInTheDocument();
    expect(server.calls().some((call) => call.method === 'POST')).toBe(false);
  });

  it('says a goal for that already exists in words, not as a code', async () => {
    serve([SIGNUP, CHECKOUT], () =>
      answer(409, {
        success: false,
        error: { code: 'GOAL_EXISTS', message: 'exists', details: { goalId: 'g_signup' } },
      }),
    );
    render(show());

    await userEvent.type(within(form()).getByLabelText('Name'), 'Signed up again');
    await userEvent.type(within(form()).getByLabelText('Event name'), 'signup');
    await userEvent.click(within(form()).getByRole('button', { name: 'Add the goal' }));

    expect(await within(form()).findByText('A goal for that already exists.')).toBeInTheDocument();
  });

  it('shows somebody who is not an owner the form, disabled, with the reason', async () => {
    serve();
    render(show('viewer'));

    await waitFor(() => expect(within(list()).getByText('Signed up')).toBeInTheDocument());
    expect(
      within(form()).getByText('Only an owner of this site can add or remove goals.'),
    ).toBeInTheDocument();
    expect(within(form()).getByLabelText('Name')).toBeDisabled();
    expect(within(form()).getByRole('button', { name: 'Add the goal' })).toBeDisabled();
    expect(within(list()).queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('Goals, deleting one', () => {
  it('asks first, and says that nothing is lost', async () => {
    const server = serve();
    render(show());
    await waitFor(() => expect(within(list()).getByText('Signed up')).toBeInTheDocument());

    const row = within(list()).getByText('Signed up').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(
      within(list()).getByText(
        'Delete Signed up? Nothing is lost: its numbers are worked out from your events, so adding it again brings them back.',
      ),
    ).toBeInTheDocument();

    await userEvent.click(within(list()).getByRole('button', { name: 'Keep it' }));
    expect(within(list()).queryByText(/Nothing is lost/)).toBeNull();
    expect(server.calls().some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('deletes it, and takes it off the reports if it was the one on', async () => {
    const server = serve();
    window.history.replaceState(null, '', '/s_test/goals?goal=g_signup');
    render(show());
    await waitFor(() => expect(within(list()).getByText('Signed up')).toBeInTheDocument());

    const row = within(list()).getByText('Signed up').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(list()).getByRole('button', { name: 'Delete it' }));

    await waitFor(() => expect(server.calls().some((call) => call.method === 'DELETE')).toBe(true));
    const deleted = server.calls().find((call) => call.method === 'DELETE');
    expect(deleted?.url.pathname).toBe('/api/sites/s_test/goals/g_signup');
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});
