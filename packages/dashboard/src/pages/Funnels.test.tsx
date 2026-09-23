import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Funnels } from './Funnels.js';

// The Funnels page: the list, choosing one into the link, building one and
// taking one away.
//
// The cases that matter most are the ones about the link and about who may do
// what. A funnel is a view somebody sends, so choosing one writes it into the
// URL and a link naming one that is gone says so rather than drawing a
// stranger; and only an owner builds or deletes one, with everybody else shown
// the builder disabled and the reason.

const NOW = Date.UTC(2026, 8, 20, 9, 0, 0);

const SITE = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
  teamId: 't_own',
  settings: {
    ipMode: 'anonymized' as const,
    visitorIdMode: 'persistent' as 'persistent' | 'cookieless',
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
  createdBy: 'u_1',
  createdAt: NOW - 86_400_000,
};

const CHECKOUT = {
  siteId: 's_test',
  id: 'f_checkout',
  name: 'Pricing to signup',
  window: '7d' as const,
  steps: [
    { kind: 'page' as const, match: '/pricing', name: '/pricing' },
    { kind: 'event' as const, match: 'signup', name: 'Signed up', goalId: 'g_signup' },
  ],
  createdBy: 'u_1',
  createdAt: NOW - 7_200_000,
};

const DOCS = {
  siteId: 's_test',
  id: 'f_docs',
  name: 'Docs in one sitting',
  window: 'visit' as const,
  steps: [
    { kind: 'page' as const, match: '/docs', name: '/docs' },
    { kind: 'page' as const, match: '/docs/install', name: '/docs/install' },
    { kind: 'page' as const, match: '/pricing', name: '/pricing' },
  ],
  createdBy: 'u_1',
  createdAt: NOW - 3_600_000,
};

type FunnelRow = typeof CHECKOUT | typeof DOCS;

function answer(status: number, body: unknown): Response {
  return { status, ok: status < 400, json: () => Promise.resolve(body) } as unknown as Response;
}

function ok(data: unknown, meta?: unknown): Response {
  return answer(200, { success: true, data, meta });
}

function refused(status: number, code: string, details?: unknown): Response {
  return answer(status, { success: false, error: { code, message: code, details } });
}

interface Server {
  calls: () => { method: string; url: URL; body: unknown }[];
}

function serve(
  funnels: FunnelRow[] = [CHECKOUT, DOCS],
  create: () => Response = () => answer(201, { success: true, data: { funnel: { ...DOCS, id: 'f_new' } } }),
  goals: (typeof SIGNUP)[] = [SIGNUP],
): Server {
  const fetcher = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/funnels') && method === 'POST') {
      return Promise.resolve(create());
    }
    if (url.pathname.includes('/funnels/') && method === 'DELETE') {
      return Promise.resolve(ok({ deleted: true }));
    }
    if (url.pathname.endsWith('/funnels')) {
      return Promise.resolve(ok({ funnels }, { siteId: 's_test', max: 50, maxSteps: 8 }));
    }
    if (url.pathname.endsWith('/goals')) {
      return Promise.resolve(ok({ goals }));
    }
    return Promise.resolve(refused(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetcher);
  return {
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

function show(
  role: 'owner' | 'viewer' = 'owner',
  mode: 'persistent' | 'cookieless' = 'persistent',
): JSX.Element {
  const site = { ...SITE, settings: { ...SITE.settings, visitorIdMode: mode } };
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: {
      actor: { kind: 'session', id: 'u_1' },
      user: null,
      sites: [site],
      teams: [{ id: 't_own', name: 'Ours', role }],
    },
    site,
    now: NOW,
    goals: [SIGNUP],
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Funnels />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function list(): HTMLElement {
  return screen.getByRole('region', { name: 'Funnels' });
}

function builder(): HTMLElement {
  return screen.getByRole('region', { name: 'Add a funnel' });
}

function step(number: number): HTMLElement {
  return within(builder()).getByRole('group', { name: `Step ${number}` });
}

function param(): string | null {
  return new URLSearchParams(window.location.search).get('funnel');
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/funnels');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Funnels, the list', () => {
  it('lists each funnel with its steps and its window, the oldest one chosen', async () => {
    serve();
    render(show());

    const first = await within(list()).findByRole('button', { name: 'Pricing to signup' });
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(within(list()).getByRole('button', { name: 'Docs in one sitting' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const steps = within(list()).getByRole('list', { name: 'Steps of Pricing to signup' });
    expect(within(steps).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '/pricing',
      'Signed up',
    ]);
    expect(within(list()).getByText('Within 7 days')).toBeInTheDocument();
    expect(within(list()).getByText('Same visit')).toBeInTheDocument();
  });

  it('puts the funnel chosen into the link and stays on the page', async () => {
    serve();
    render(show());

    await userEvent.click(await within(list()).findByRole('button', { name: 'Docs in one sitting' }));

    expect(window.location.pathname).toBe('/s_test/funnels');
    expect(param()).toBe('f_docs');
    expect(within(list()).getByRole('button', { name: 'Docs in one sitting' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('says a funnel the link named no longer exists, rather than drawing a stranger in silence', async () => {
    serve();
    window.history.replaceState(null, '', '/s_test/funnels?funnel=f_gone');
    render(show());

    expect(await within(list()).findByText('That funnel no longer exists.')).toBeInTheDocument();
    expect(within(list()).getByRole('button', { name: 'Pricing to signup' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('says there are none yet, and that the builder is below', async () => {
    serve([]);
    render(show());

    expect(await within(list()).findByText('No funnels yet.')).toBeInTheDocument();
    expect(
      within(list()).getByText(
        'Add one below: two to eight steps, each a page being viewed or one of your goals.',
      ),
    ).toBeInTheDocument();
  });
});

describe('Funnels, building one', () => {
  it('sends a page step and a goal step with the window, and draws what it built', async () => {
    const server = serve();
    render(show());
    await within(list()).findByRole('button', { name: 'Pricing to signup' });

    await userEvent.type(within(builder()).getByLabelText('Name'), 'Checkout');
    await userEvent.selectOptions(within(builder()).getByLabelText('Time to finish'), '1d');
    await userEvent.type(within(step(1)).getByLabelText('Page path'), '/checkout');
    await userEvent.selectOptions(within(step(2)).getByLabelText('Counts when'), 'goal');
    await userEvent.selectOptions(within(step(2)).getByLabelText('Goal'), 'g_signup');
    await userEvent.click(within(builder()).getByRole('button', { name: 'Add the funnel' }));

    await waitFor(() => expect(param()).toBe('f_new'));
    const posted = server.calls().find((call) => call.method === 'POST');
    expect(posted?.url.pathname).toBe('/api/sites/s_test/funnels');
    expect(posted?.body).toEqual({
      name: 'Checkout',
      window: '1d',
      steps: [{ page: '/checkout' }, { goalId: 'g_signup' }],
    });
    expect(
      server.calls().filter((call) => call.method === 'GET' && call.url.pathname.endsWith('/funnels')),
    ).toHaveLength(2);
    expect(within(builder()).getByLabelText('Name')).toHaveValue('');
  });

  it('offers seven days on a site that remembers people, and the same visit on one that cannot', async () => {
    serve();
    const { unmount } = render(show());
    expect(within(builder()).getByLabelText('Time to finish')).toHaveValue('7d');
    unmount();

    render(show('owner', 'cookieless'));
    expect(within(builder()).getByLabelText('Time to finish')).toHaveValue('visit');
    // And it says in words to choose a time window for a step a server sends.
    expect(
      within(builder()).getByText(/a step your server confirms, like a payment/),
    ).toBeInTheDocument();
  });

  it('moves a step with what was typed in it, and keeps between two and eight', async () => {
    serve();
    render(show());

    await userEvent.type(within(step(1)).getByLabelText('Page path'), '/first');
    await userEvent.type(within(step(2)).getByLabelText('Page path'), '/second');
    expect(within(step(1)).getByRole('button', { name: 'Move up' })).toBeDisabled();
    expect(within(step(2)).getByRole('button', { name: 'Move down' })).toBeDisabled();
    expect(within(step(1)).getByRole('button', { name: 'Remove' })).toBeDisabled();

    await userEvent.click(within(step(1)).getByRole('button', { name: 'Move down' }));
    expect(within(step(1)).getByLabelText('Page path')).toHaveValue('/second');
    expect(within(step(2)).getByLabelText('Page path')).toHaveValue('/first');

    await userEvent.click(within(step(2)).getByRole('button', { name: 'Move up' }));
    expect(within(step(1)).getByLabelText('Page path')).toHaveValue('/first');

    const add = within(builder()).getByRole('button', { name: 'Add a step' });
    for (let count = 2; count < 8; count += 1) {
      await userEvent.click(add);
    }
    expect(within(builder()).getAllByRole('group', { name: /^Step \d$/ })).toHaveLength(8);
    expect(add).toBeDisabled();
    expect(within(builder()).getByText('A funnel has at most 8 steps.')).toBeInTheDocument();

    await userEvent.click(within(step(3)).getByRole('button', { name: 'Remove' }));
    expect(within(builder()).getAllByRole('group', { name: /^Step \d$/ })).toHaveLength(7);
    expect(add).toBeEnabled();
  });

  it('names every field that needs something before asking the server', async () => {
    const server = serve();
    render(show());

    await userEvent.type(within(step(1)).getByLabelText('Page path'), 'pricing');
    await userEvent.selectOptions(within(step(2)).getByLabelText('Counts when'), 'goal');
    await userEvent.click(within(builder()).getByRole('button', { name: 'Add the funnel' }));

    expect(within(builder()).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(within(step(1)).getByText('A path starts with /.')).toBeInTheDocument();
    expect(within(step(2)).getByText('This needs a value.')).toBeInTheDocument();
    expect(within(step(2)).getByLabelText('Goal')).toHaveAttribute('aria-invalid', 'true');
    expect(server.calls().some((call) => call.method === 'POST')).toBe(false);
  });

  it('says the same funnel exists in words, and links to it', async () => {
    serve([CHECKOUT, DOCS], () => refused(409, 'FUNNEL_EXISTS', { funnelId: 'f_docs' }));
    render(show());

    await userEvent.type(within(builder()).getByLabelText('Name'), 'Docs again');
    await userEvent.type(within(step(1)).getByLabelText('Page path'), '/docs');
    await userEvent.type(within(step(2)).getByLabelText('Page path'), '/docs/install');
    await userEvent.click(within(builder()).getByRole('button', { name: 'Add the funnel' }));

    expect(
      await within(builder()).findByText('A funnel with these steps and this window already exists.'),
    ).toBeInTheDocument();
    await userEvent.click(within(builder()).getByRole('link', { name: 'Show it' }));
    expect(param()).toBe('f_docs');
  });

  it('names the step whose goal was deleted in the meantime', async () => {
    serve([CHECKOUT], () => refused(404, 'GOAL_NOT_FOUND', { step: 1 }));
    render(show());

    await userEvent.type(within(builder()).getByLabelText('Name'), 'Signed up after pricing');
    await userEvent.type(within(step(1)).getByLabelText('Page path'), '/pricing');
    await userEvent.selectOptions(within(step(2)).getByLabelText('Counts when'), 'goal');
    await userEvent.selectOptions(within(step(2)).getByLabelText('Goal'), 'g_signup');
    await userEvent.click(within(builder()).getByRole('button', { name: 'Add the funnel' }));

    expect(
      await within(step(2)).findByText('That goal no longer exists. Choose another.'),
    ).toBeInTheDocument();
    expect(within(step(1)).queryByRole('alert')).toBeNull();
  });

  it('says where goals come from on a site that has none, and the page option still works', async () => {
    serve([], undefined, []);
    render(show());

    await userEvent.selectOptions(within(step(2)).getByLabelText('Counts when'), 'goal');
    expect(await within(step(2)).findByText('This site has no goals yet.')).toBeInTheDocument();
    expect(within(step(2)).getByRole('link', { name: 'Add one on the Goals page' })).toHaveAttribute(
      'href',
      '/s_test/goals',
    );
    expect(within(step(1)).getByLabelText('Page path')).toBeEnabled();
  });

  it('shows somebody who is not an owner the builder, disabled, with the reason', async () => {
    serve();
    render(show('viewer'));

    await within(list()).findByRole('button', { name: 'Pricing to signup' });
    expect(
      within(builder()).getByText('Only an owner of this site can add or remove funnels.'),
    ).toBeInTheDocument();
    expect(within(builder()).getByLabelText('Name')).toBeDisabled();
    expect(within(builder()).getByRole('button', { name: 'Add the funnel' })).toBeDisabled();
    expect(within(list()).queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('Funnels, deleting one', () => {
  it('asks first, and says that nothing is lost', async () => {
    const server = serve();
    render(show());

    const item = (await within(list()).findByRole('button', { name: 'Pricing to signup' })).closest(
      'li',
    ) as HTMLElement;
    await userEvent.click(within(item).getByRole('button', { name: 'Delete' }));
    expect(
      within(item).getByText(
        'Delete Pricing to signup? Nothing is lost: its numbers are worked out from your events, so adding it again brings them back.',
      ),
    ).toBeInTheDocument();

    await userEvent.click(within(item).getByRole('button', { name: 'Keep it' }));
    expect(within(list()).queryByText(/Nothing is lost/)).toBeNull();
    expect(server.calls().some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('deletes it, and the link stops naming it if it was the one named', async () => {
    const server = serve();
    window.history.replaceState(null, '', '/s_test/funnels?funnel=f_docs&range=30d');
    render(show());

    const item = (await within(list()).findByRole('button', { name: 'Docs in one sitting' })).closest(
      'li',
    ) as HTMLElement;
    await userEvent.click(within(item).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(item).getByRole('button', { name: 'Delete it' }));

    await waitFor(() => expect(server.calls().some((call) => call.method === 'DELETE')).toBe(true));
    const deleted = server.calls().find((call) => call.method === 'DELETE');
    expect(deleted?.url.pathname).toBe('/api/sites/s_test/funnels/f_docs');
    await waitFor(() => expect(window.location.search).toBe('?range=30d'));
  });
});
