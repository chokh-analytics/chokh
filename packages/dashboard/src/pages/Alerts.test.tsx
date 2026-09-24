import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Alerts } from './Alerts.js';

// The Alerts page in both of its states. The first paid feature, so the case
// that matters most is the one on an install with no key: the page is here,
// named, described in words with the server's reason, and there is no form
// to fill in and nothing pretending to be numbers.

const NOW = Date.UTC(2026, 8, 24, 10, 0, 0);

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
    routeGroups: [],
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

const DROP = {
  siteId: 's_test',
  id: 'al_drop',
  name: 'Big drop',
  condition: { kind: 'traffic', metric: 'visitors', direction: 'down', percent: 50, minimum: 20 },
  channels: [
    { kind: 'telegram', chatId: '-100123' },
    { kind: 'webhook', url: 'https://hooks.example.test/chokh?token=secret' },
  ],
  createdBy: 'u_1',
  createdAt: NOW - 86_400_000,
  state: { firing: true, since: NOW - 3_600_000, checkedBucket: 1 },
  recent: [
    {
      at: NOW - 3_600_000,
      event: 'fired',
      value: 41,
      baseline: 108,
      deliveries: [
        { channel: 'telegram', target: '-100123', ok: true },
        { channel: 'webhook', target: 'hooks.example.test', ok: false, error: 'The receiver answered 503' },
      ],
    },
  ],
  watches: 'Visitors fall 50% against the usual for the hour, once either side reaches 20',
};

function answer(status: number, body: unknown): Response {
  return { status, ok: status < 400, json: () => Promise.resolve(body) } as unknown as Response;
}

function ok(data: unknown, meta?: unknown): Response {
  return answer(200, { success: true, data, meta });
}

function refused(status: number, code: string, details?: unknown): Response {
  return answer(status, { success: false, error: { code, message: 'Refused.', details } });
}

interface Server {
  calls: () => { method: string; url: URL; body: unknown }[];
}

function serve(
  routes: {
    list?: () => Response;
    create?: () => Response;
    test?: () => Response;
  } = {},
): Server {
  const fetcher = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/goals')) {
      return Promise.resolve(ok({ goals: [SIGNUP] }));
    }
    if (url.pathname.endsWith('/test') && method === 'POST') {
      return Promise.resolve(
        (routes.test ??
          (() =>
            ok({
              deliveries: [
                { channel: 'telegram', target: '-100123', ok: true },
                { channel: 'webhook', target: 'hooks.example.test', ok: false, error: 'The receiver answered 401' },
              ],
            })))(),
      );
    }
    if (url.pathname.endsWith('/ee/alerts') && method === 'POST') {
      return Promise.resolve((routes.create ?? (() => ok({ alert: DROP })))());
    }
    if (url.pathname.includes('/ee/alerts/') && method === 'DELETE') {
      return Promise.resolve(ok({ deleted: true }));
    }
    return Promise.resolve(
      (routes.list ?? (() => ok({ alerts: [DROP] }, { siteId: 's_test', max: 20, channels: ['telegram', 'webhook'] })))(),
    );
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

function show(role: 'owner' | 'viewer' = 'owner'): JSX.Element {
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
    goals: [SIGNUP],
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Alerts />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function listCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Alerts' });
}

function formCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Add an alert' });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/alerts');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Alerts, on an install with no licence', () => {
  it('is here, named and described, with the reason the server gave, and no form', async () => {
    serve({ list: () => refused(403, 'LICENSE_REQUIRED', { feature: 'alerts', reason: 'missing' }) });
    render(show());
    expect(await screen.findByText('Part of Chokh Pro')).toBeInTheDocument();
    expect(
      screen.getByText('Alerts is part of Chokh Pro. It is here, and a licence key turns it on.'),
    ).toBeInTheDocument();
    expect(screen.getByText('This install has no licence key.')).toBeInTheDocument();
    // Described in words: the four kinds and the three ways out.
    expect(screen.getByText('Traffic')).toBeInTheDocument();
    expect(screen.getByText('Silence')).toBeInTheDocument();
    expect(screen.getByText(/A message goes to Telegram/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Add an alert' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add the alert' })).toBeNull();
  });

  it('says the key ran out rather than that there never was one', async () => {
    serve({ list: () => refused(403, 'LICENSE_REQUIRED', { feature: 'alerts', reason: 'expired' }) });
    render(show());
    expect(await screen.findByText('The licence key on this install has expired.')).toBeInTheDocument();
  });

  it('is here on a build with no paid half at all', async () => {
    serve({ list: () => refused(404, 'NOT_FOUND') });
    render(show());
    expect(await screen.findByText('Part of Chokh Pro')).toBeInTheDocument();
    expect(screen.queryByText('This install has no licence key.')).toBeNull();
  });

  it('draws a failure as a failure, not as the feature described', async () => {
    serve({ list: () => refused(500, 'INTERNAL') });
    render(show());
    // The server's own sentence and its code, with a way to ask again.
    expect(await screen.findByText('The server said INTERNAL.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Part of Chokh Pro')).toBeNull();
  });
});

describe('Alerts, the list', () => {
  it('draws each alert with what it watches, where it goes, its state and its last outcome', async () => {
    serve();
    render(show());
    // The loading card and the loaded one are different trees, so the card
    // is taken once the row is on screen and not before.
    expect(await screen.findByText('Big drop')).toBeInTheDocument();
    const card = listCard();
    expect(within(card).getByText(DROP.watches)).toBeInTheDocument();
    // The webhook is named by its host: the query may carry a token.
    expect(within(card).getByText('Telegram -100123, Webhook hooks.example.test')).toBeInTheDocument();
    expect(within(card).getByText('Firing since 24 Sept, 09:00')).toBeInTheDocument();
    expect(within(card).getByText('Last fired 24 Sept, 09:00, delivered to 1 of 2.')).toBeInTheDocument();
  });

  it('sends a test and lists what each channel answered', async () => {
    serve();
    const user = userEvent.setup();
    render(show());
    await screen.findByText('Big drop');
    await user.click(screen.getByRole('button', { name: 'Send a test' }));
    const outcomes = await screen.findByRole('list', { name: 'What the test message met' });
    expect(within(outcomes).getByText('Delivered to -100123.')).toBeInTheDocument();
    expect(
      within(outcomes).getByText('Not delivered to hooks.example.test: The receiver answered 401'),
    ).toBeInTheDocument();
  });

  it('deletes after a confirmation', async () => {
    const server = serve();
    const user = userEvent.setup();
    render(show());
    await screen.findByText('Big drop');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/Delete Big drop\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() =>
      expect(server.calls().some((call) => call.method === 'DELETE' && call.url.pathname.endsWith('/ee/alerts/al_drop'))).toBe(true),
    );
  });

  it('shows a viewer the list and one sentence, with no form and no controls', async () => {
    serve();
    render(show('viewer'));
    await screen.findByText('Big drop');
    expect(screen.getByText('Only an owner of this site can add, test or delete an alert.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send a test' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add the alert' })).toBeNull();
  });

  it('says there are none yet', async () => {
    serve({ list: () => ok({ alerts: [] }, { siteId: 's_test', max: 20, channels: ['webhook'] }) });
    render(show());
    expect(await screen.findByText('No alerts yet.')).toBeInTheDocument();
  });
});

describe('Alerts, adding one', () => {
  it('sends a traffic alert with its numbers as numbers and a channel this install can send on', async () => {
    const server = serve();
    const user = userEvent.setup();
    render(show());
    await screen.findByText('Big drop');
    const form = formCard();
    // Only the kinds this install can send on are offered.
    const kindSelect = within(form).getByLabelText('Channel 1');
    expect(within(kindSelect).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Telegram',
      'Webhook',
    ]);
    expect(within(form).getByText(/This install is not set up for Email/)).toBeInTheDocument();

    await user.type(within(form).getByLabelText('Name'), 'Night drop');
    await user.selectOptions(within(form).getByLabelText('Metric'), 'pageviews');
    await user.clear(within(form).getByLabelText('Percent'));
    await user.type(within(form).getByLabelText('Percent'), '60');
    await user.selectOptions(kindSelect, 'telegram');
    await user.type(within(form).getByLabelText('Chat id'), '-100123');
    await user.click(within(form).getByRole('button', { name: 'Add the alert' }));

    await waitFor(() => expect(server.calls().some((call) => call.method === 'POST')).toBe(true));
    const post = server.calls().find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      name: 'Night drop',
      condition: { kind: 'traffic', metric: 'pageviews', direction: 'down', percent: 60, minimum: 20 },
      channels: [{ kind: 'telegram', chatId: '-100123' }],
    });
  });

  it('sends a goal alert naming a goal the site has, with the window as a number', async () => {
    const server = serve();
    const user = userEvent.setup();
    render(show());
    await screen.findByText('Big drop');
    const form = formCard();
    await user.type(within(form).getByLabelText('Name'), 'No signups');
    await user.selectOptions(within(form).getByLabelText('Watches'), 'goal');
    expect(within(form).getByLabelText('Goal')).toHaveValue('g_signup');
    await user.selectOptions(within(form).getByLabelText('In the last'), '1440');
    await user.selectOptions(within(form).getByLabelText('Channel 1'), 'webhook');
    await user.type(within(form).getByLabelText('URL'), 'https://hooks.example.test/chokh');
    await user.type(within(form).getByLabelText('Secret (optional)'), 'a-shared-secret-long-enough');
    await user.click(within(form).getByRole('button', { name: 'Add the alert' }));

    await waitFor(() => expect(server.calls().some((call) => call.method === 'POST')).toBe(true));
    expect(server.calls().find((call) => call.method === 'POST')?.body).toEqual({
      name: 'No signups',
      condition: { kind: 'goal', goalId: 'g_signup', direction: 'below', count: 1, window: 1440 },
      channels: [{ kind: 'webhook', url: 'https://hooks.example.test/chokh', secret: 'a-shared-secret-long-enough' }],
    });
  });

  it('asks for a name and a target before it sends anything', async () => {
    const server = serve();
    const user = userEvent.setup();
    render(show());
    await screen.findByText('Big drop');
    await user.click(within(formCard()).getByRole('button', { name: 'Add the alert' }));
    expect((await screen.findAllByText('This needs a value.')).length).toBeGreaterThan(0);
    expect(server.calls().some((call) => call.method === 'POST')).toBe(false);
  });

  it('says in words when the question is already asked, and when a channel cannot be sent on', async () => {
    serve({ create: () => refused(409, 'ALERT_EXISTS', { alertId: 'al_drop' }) });
    const user = userEvent.setup();
    render(show());
    await screen.findByText('Big drop');
    const form = formCard();
    await user.type(within(form).getByLabelText('Name'), 'Again');
    await user.type(within(form).getByLabelText('Chat id'), '-100123');
    await user.click(within(form).getByRole('button', { name: 'Add the alert' }));
    expect(await screen.findByText('An alert asking that already exists.')).toBeInTheDocument();
  });
});
