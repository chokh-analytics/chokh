import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Digests } from './Digests.js';

// The digests section (AN-RPT01): described on an install with no key, the
// list with what each one does and what happened last, send now with each
// address's outcome, delete behind a confirmation, and the form for one
// more, which says when this install cannot mail at all.

const NOW = Date.UTC(2026, 8, 25, 10, 0, 0);

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
    timezone: 'Asia/Dhaka',
    allowUnsignedIdentify: false,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
    routeGroups: [],
  },
};

const DAILY = {
  siteId: 's_test',
  id: 'dg_daily',
  cadence: 'daily' as const,
  to: ['ops@example.test', 'founder@example.test'],
  hour: 8,
  createdBy: 'u_1',
  createdAt: NOW - 86_400_000,
  lastPeriod: 'd:2026-09-24',
  last: {
    at: NOW - 7_200_000,
    period: 'd:2026-09-24',
    deliveries: [
      { channel: 'email' as const, target: 'ops@example.test', ok: true },
      { channel: 'email' as const, target: 'founder@example.test', ok: false, error: 'Mailbox unavailable' },
    ],
  },
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

function serve(routes: { list?: () => Response; create?: () => Response } = {}): Server {
  const fetcher = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/send') && method === 'POST') {
      return Promise.resolve(ok({ deliveries: DAILY.last.deliveries, period: 'd:2026-09-24' }));
    }
    if (url.pathname.endsWith('/ee/digests') && method === 'POST') {
      return Promise.resolve((routes.create ?? (() => ok({ digest: DAILY })))());
    }
    if (url.pathname.includes('/ee/digests/') && method === 'DELETE') {
      return Promise.resolve(ok({ deleted: true }));
    }
    return Promise.resolve(
      (routes.list ??
        (() => ok({ digests: [DAILY] }, { siteId: 's_test', maxRecipients: 5, mail: true, needs: [] })))(),
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

function show(owner = true): JSX.Element {
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: {
      actor: { kind: 'session', id: 'u_1' },
      user: null,
      sites: [SITE],
      teams: [{ id: 't_own', name: 'Ours', role: owner ? 'owner' : 'viewer' }],
    },
    site: SITE,
    now: NOW,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Digests owner={owner} />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function listCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Digests' });
}

function formCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Add a digest' });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/alerts');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the digests section', () => {
  it('is named and described on an install with no key, with nothing to fill in', async () => {
    serve({ list: () => refused(403, 'LICENSE_REQUIRED', { feature: 'digests', reason: 'missing' }) });
    render(show());
    await waitFor(() => expect(screen.getByText('Part of Chokh Pro')).toBeInTheDocument());
    expect(
      within(listCard()).getByText('Digests is part of Chokh Pro. It is here, and a licence key turns it on.'),
    ).toBeInTheDocument();
    expect(within(listCard()).getByText('This install has no licence key.')).toBeInTheDocument();
    expect(within(listCard()).getByText(/A digest is the Overview in a mail/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Add a digest' })).toBeNull();
  });

  it('lists a digest with its schedule in the site zone, its addresses and what happened last', async () => {
    serve();
    render(show());
    await waitFor(() => expect(within(listCard()).getByText('Daily')).toBeInTheDocument());
    expect(within(listCard()).getByText('Every day at 08:00, about the day before')).toBeInTheDocument();
    expect(within(listCard()).getByText('To ops@example.test, founder@example.test')).toBeInTheDocument();
    expect(within(listCard()).getByText(/Last sent .* for 2026-09-24, delivered to 1 of 2/)).toBeInTheDocument();
  });

  it('sends now and lists each address, and deletes behind a confirmation', async () => {
    const server = serve();
    render(show());
    await waitFor(() => expect(within(listCard()).getByText('Daily')).toBeInTheDocument());
    await userEvent.click(within(listCard()).getByRole('button', { name: 'Send now' }));
    const outcomes = await within(listCard()).findByRole('list', { name: 'What the mail met' });
    expect(within(outcomes).getAllByRole('listitem')).toHaveLength(2);
    expect(within(outcomes).getByText(/founder@example.test/)).toHaveTextContent('Mailbox unavailable');
    expect(server.calls().some((call) => call.method === 'POST' && call.url.pathname.endsWith('/dg_daily/send'))).toBe(true);

    await userEvent.click(within(listCard()).getByRole('button', { name: 'Delete' }));
    expect(within(listCard()).getByText('Delete the daily digest? Nothing counted changes.')).toBeInTheDocument();
    await userEvent.click(within(listCard()).getByRole('button', { name: 'Delete it' }));
    await waitFor(() =>
      expect(server.calls().some((call) => call.method === 'DELETE' && call.url.pathname.endsWith('/dg_daily'))).toBe(true),
    );
  });

  it('adds a weekly digest from the form, addresses one per line, and refuses a bad address first', async () => {
    const server = serve();
    render(show());
    await waitFor(() => expect(formCard()).toBeInTheDocument());
    const form = within(formCard());
    await userEvent.selectOptions(form.getByLabelText('How often'), 'weekly');
    await userEvent.selectOptions(form.getByLabelText('On'), '5');
    await userEvent.selectOptions(form.getByLabelText('At (Asia/Dhaka)'), '9');
    await userEvent.type(form.getByLabelText('Addresses'), 'ops@example.test\nnot an address');
    await userEvent.click(form.getByRole('button', { name: 'Add the digest' }));
    expect(form.getByText('One of these is not an address.')).toBeInTheDocument();
    expect(server.calls().filter((call) => call.method === 'POST')).toHaveLength(0);

    await userEvent.clear(form.getByLabelText('Addresses'));
    await userEvent.type(form.getByLabelText('Addresses'), 'ops@example.test\nfounder@example.test');
    await userEvent.click(form.getByRole('button', { name: 'Add the digest' }));
    await waitFor(() => expect(server.calls().filter((call) => call.method === 'POST')).toHaveLength(1));
    expect(server.calls().find((call) => call.method === 'POST')?.body).toEqual({
      cadence: 'weekly',
      to: ['ops@example.test', 'founder@example.test'],
      hour: 9,
      weekday: 5,
    });
  });

  it('says when this install cannot mail, and gives a viewer no form', async () => {
    serve({
      list: () => ok({ digests: [] }, { siteId: 's_test', maxRecipients: 5, mail: false, needs: ['CHOKH_MAIL_FROM'] }),
    });
    const { unmount } = render(show());
    await waitFor(() => expect(formCard()).toBeInTheDocument());
    expect(within(formCard()).getByText(/This install cannot send email: set CHOKH_MAIL_FROM/)).toBeInTheDocument();
    expect(within(formCard()).getByRole('button', { name: 'Add the digest' })).toBeDisabled();
    expect(within(listCard()).getByText('No digests yet.')).toBeInTheDocument();
    unmount();

    serve();
    render(show(false));
    await waitFor(() => expect(formCard()).toBeInTheDocument());
    expect(within(formCard()).getByText('Only an owner of this site can add or delete a digest.')).toBeInTheDocument();
    expect(within(listCard()).queryByRole('button', { name: 'Send now' })).toBeNull();
  });
});
