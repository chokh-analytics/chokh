import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import type { PublicSite } from '../lib/api.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Settings } from './Settings.js';

// The settings page: what an owner may change and what everybody may read.
//
// The cases that matter are the ones about the seams: the exact body a save
// sends, the one field that is a fact rather than a control, a rule refused
// before it is sent, and the sentence that says the routes are being
// regrouped while the jobs still owe it.

const NOW = Date.UTC(2026, 8, 24, 9, 0, 0);

const SITE: PublicSite = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io', 'www.progsity.io'],
  teamId: 't_own',
  settings: {
    ipMode: 'full' as const,
    visitorIdMode: 'persistent' as const,
    botFilter: true,
    retentionDays: 180,
    timezone: 'Asia/Dhaka',
    allowUnsignedIdentify: false,
    excludeIps: ['10.0.0.0/8'],
    excludePaths: [],
    excludeQueryParams: [],
    routeGroups: ['/courses/:slug'],
  },
};

function ok(data: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
  } as unknown as Response;
}

function refused(status: number, code: string): Response {
  return {
    status,
    ok: false,
    json: () => Promise.resolve({ success: false, error: { code, message: code } }),
  } as unknown as Response;
}

interface Call {
  method: string;
  url: URL;
  body: unknown;
}

function serve(
  patch: (body: unknown) => Response = (body) =>
    ok({ site: { ...SITE, ...(body as object), routesChangedAt: NOW } }),
): () => Call[] {
  const fetcher = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method === 'PATCH' && url.pathname === '/api/sites/s_test') {
      return Promise.resolve(patch(body));
    }
    if (url.pathname === '/api/sites/s_test/share') {
      if (method === 'DELETE') {
        return Promise.resolve(ok({ deleted: true }));
      }
      const input = (body ?? {}) as { regenerate?: boolean; password?: string | null };
      return Promise.resolve(
        ok({
          share: {
            token: input.regenerate === true ? 'tok_second_00000000000000000000' : 'tok_first_000000000000000000000',
            protected: typeof input.password === 'string',
            createdAt: NOW,
          },
        }),
      );
    }
    if (url.pathname === '/api/me') {
      return Promise.resolve(
        ok({ actor: { kind: 'session', id: 'u_1' }, user: null, sites: [SITE], teams: [] }),
      );
    }
    return Promise.resolve(refused(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetcher);
  return () =>
    fetcher.mock.calls.map(([input, init]) => ({
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      url: new URL(String(input), 'http://x'),
      body:
        typeof (init as RequestInit | undefined)?.body === 'string'
          ? JSON.parse((init as RequestInit).body as string)
          : undefined,
    }));
}

function show(role: 'owner' | 'viewer' = 'owner', site: PublicSite = SITE): JSX.Element {
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
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Settings />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function card(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/settings');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings, for an owner', () => {
  it('saves the exclusion lists as lines, and says so', async () => {
    const calls = serve();
    render(show());

    const exclusions = card('Keep your own traffic out');
    const paths = within(exclusions).getByLabelText('Paths');
    expect(paths).toBeEnabled();
    await userEvent.type(paths, '/preview/*{enter}/admin');
    await userEvent.type(within(exclusions).getByLabelText('Query parameters'), 'sid');
    await userEvent.click(within(exclusions).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patched = calls().find((call) => call.method === 'PATCH');
      expect(patched?.body).toEqual({
        settings: {
          excludeIps: ['10.0.0.0/8'],
          excludePaths: ['/preview/*', '/admin'],
          excludeQueryParams: ['sid'],
        },
      });
    });
    expect(await within(exclusions).findByRole('status')).toHaveTextContent('Saved.');
    // The shell's own "who am I" read is invalidated so the site on screen says
    // what was just saved; nothing here mounts that read, so it is not asked.
  });

  it('refuses a path that does not start with a slash before sending anything', async () => {
    const calls = serve();
    render(show());
    const exclusions = card('Keep your own traffic out');
    await userEvent.type(within(exclusions).getByLabelText('Paths'), 'preview');
    await userEvent.click(within(exclusions).getByRole('button', { name: 'Save' }));
    expect(await within(exclusions).findByRole('alert')).toHaveTextContent('A path starts with /.');
    expect(calls().some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('shows the timezone as a fact and not a control', () => {
    serve();
    render(show());
    const general = card('Site');
    expect(within(general).queryByLabelText('Timezone')).toBeNull();
    expect(within(general).getByText('Asia/Dhaka')).toBeInTheDocument();
    expect(within(general).getByText(/cannot be changed once there is history/)).toBeInTheDocument();
  });

  it('saves the site fields, retention as a number', async () => {
    const calls = serve();
    render(show());
    const general = card('Site');
    const retention = within(general).getByLabelText('Raw events kept for');
    await userEvent.clear(retention);
    await userEvent.type(retention, '90');
    await userEvent.selectOptions(within(general).getByLabelText('Addresses'), 'anonymized');
    await userEvent.click(within(general).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const patched = calls().find((call) => call.method === 'PATCH');
      expect(patched?.body).toEqual({
        name: 'Progsity',
        domains: ['progsity.io', 'www.progsity.io'],
        settings: {
          retentionDays: 90,
          ipMode: 'anonymized',
          visitorIdMode: 'persistent',
          botFilter: true,
          allowUnsignedIdentify: false,
        },
      });
    });
  });

  it('saves the route rules in order, refuses one that is not a path, and says the regroup is owed', async () => {
    const calls = serve();
    render(show());
    const routes = card('Route groups');
    const rules = within(routes).getByLabelText('Rules');
    expect(rules).toHaveValue('/courses/:slug');

    await userEvent.type(rules, '{enter}learn/:course');
    await userEvent.click(within(routes).getByRole('button', { name: 'Save' }));
    expect(await within(routes).findByRole('alert')).toHaveTextContent(/absolute path/);
    expect(calls().some((call) => call.method === 'PATCH')).toBe(false);

    await userEvent.clear(rules);
    await userEvent.type(rules, '/courses/:slug{enter}/learn/:course/:lesson');
    await userEvent.click(within(routes).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const patched = calls().find((call) => call.method === 'PATCH');
      expect(patched?.body).toEqual({
        settings: { routeGroups: ['/courses/:slug', '/learn/:course/:lesson'] },
      });
    });
    expect(await within(routes).findByText(/regrouped on the next hourly pass/)).toBeInTheDocument();
  });

  it('shows the server refusal under the form', async () => {
    serve(() => refused(400, 'INVALID_BODY'));
    render(show());
    const exclusions = card('Keep your own traffic out');
    await userEvent.type(within(exclusions).getByLabelText('Addresses'), '{enter}office');
    await userEvent.click(within(exclusions).getByRole('button', { name: 'Save' }));
    expect(await within(exclusions).findByRole('alert')).toHaveTextContent('INVALID_BODY');
  });
});

describe('Settings, for a viewer', () => {
  it('draws every control disabled and says who may change them', () => {
    serve();
    render(show('viewer'));
    expect(screen.getByText(/Only an owner of this site can change its settings/)).toBeInTheDocument();
    expect(within(card('Site')).getByLabelText('Name')).toBeDisabled();
    expect(within(card('Keep your own traffic out')).getByLabelText('Paths')).toBeDisabled();
    expect(within(card('Route groups')).getByLabelText('Rules')).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: 'Save' })) {
      expect(button).toBeDisabled();
    }
  });

  it('says the regroup is owed while the site row carries the mark', () => {
    serve();
    render(show('viewer', { ...SITE, routesChangedAt: NOW }));
    expect(screen.getByText(/regrouped on the next hourly pass/)).toBeInTheDocument();
  });
});

// The public share card (AN-RPT01): one call per control, and the card draws
// what the site row says.
describe('Settings, the public share', () => {
  it('makes a link, shows it with a copy control, and puts a password on it', async () => {
    const calls = serve();
    const { rerender } = render(show('owner'));
    const sharing = card('Public share');
    await userEvent.click(within(sharing).getByRole('button', { name: 'Make a link' }));
    await waitFor(() =>
      expect(calls().some((call) => call.method === 'PUT' && call.url.pathname === '/api/sites/s_test/share')).toBe(true),
    );

    // The site row refreshed carries the share; the card draws it.
    const shared = { ...SITE, share: { token: 'tok_first_000000000000000000000', protected: false, createdAt: NOW } };
    rerender(show('owner', shared));
    expect(within(card('Public share')).getByLabelText('Link')).toHaveValue(
      `${location.origin}/share/tok_first_000000000000000000000`,
    );
    expect(within(card('Public share')).getByText('Anybody with the link can read it.')).toBeInTheDocument();
    // The two snippets carry the link's token: the badge as an image URL, the
    // card as an iframe of the embed.
    const snippets = within(card('Public share')).getAllByRole('code');
    expect(snippets.map((code) => code.textContent)).toEqual([
      `![Visitors](${location.origin}/api/share/tok_first_000000000000000000000/widget.svg?metric=visitors&range=30d)`,
      `<iframe src="${location.origin}/share/tok_first_000000000000000000000/embed?range=30d" width="640" height="160" title="Progsity" loading="lazy" style="border:0"></iframe>`,
    ]);

    await userEvent.type(within(card('Public share')).getByLabelText('Password'), 'short');
    await userEvent.click(within(card('Public share')).getByRole('button', { name: 'Set a password' }));
    expect(calls().filter((call) => call.method === 'PUT')).toHaveLength(1);
    await userEvent.type(within(card('Public share')).getByLabelText('Password'), '-and-longer');
    await userEvent.click(within(card('Public share')).getByRole('button', { name: 'Set a password' }));
    await waitFor(() => expect(calls().filter((call) => call.method === 'PUT')).toHaveLength(2));
    expect(calls().at(-1)?.body).toEqual({ password: 'short-and-longer' });
  });

  it('replaces the link, removes the password and turns the share off, one call each', async () => {
    const calls = serve();
    const shared = { ...SITE, share: { token: 'tok_first_000000000000000000000', protected: true, createdAt: NOW } };
    render(show('owner', shared));
    const sharing = card('Public share');
    expect(within(sharing).getByText('A password stands in the way.')).toBeInTheDocument();
    await userEvent.click(within(sharing).getByRole('button', { name: 'Remove the password' }));
    await waitFor(() => expect(calls().at(-1)?.body).toEqual({ password: null }));
    await userEvent.click(within(sharing).getByRole('button', { name: 'New link' }));
    await waitFor(() => expect(calls().at(-1)?.body).toEqual({ regenerate: true }));
    await userEvent.click(within(sharing).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(calls().some((call) => call.method === 'DELETE' && call.url.pathname === '/api/sites/s_test/share')).toBe(true),
    );
  });

  it('draws the controls disabled for a viewer', () => {
    serve();
    const shared = { ...SITE, share: { token: 'tok_first_000000000000000000000', protected: false, createdAt: NOW } };
    render(show('viewer', shared));
    const sharing = card('Public share');
    expect(within(sharing).getByRole('button', { name: 'Set a password' })).toBeDisabled();
    expect(within(sharing).getByRole('button', { name: 'New link' })).toBeDisabled();
    expect(within(sharing).getByRole('button', { name: 'Turn off' })).toBeDisabled();
  });
});
