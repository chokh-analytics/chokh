import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { dayBounds } from '@chokh/store/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import NotesPanel, { instantOf } from './Notes.js';

// The annotations panel: who sees the form, what the form posts, and what a
// refusal says. The instant is the one thing worth getting wrong here, so the
// date and the time are proved against the site's own midnight.

const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const DHAKA = 'Asia/Dhaka';

const SITE = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
  teamId: 'default',
  settings: {
    ipMode: 'anonymized' as const,
    visitorIdMode: 'persistent' as const,
    botFilter: true,
    retentionDays: 180,
    timezone: DHAKA,
    allowUnsignedIdentify: false,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
    routeGroups: [],
  },
};

const DEPLOY = {
  siteId: 's_test',
  id: 'an_deploy',
  at: NOW - 3 * 60 * 60_000,
  kind: 'deploy' as const,
  text: 'v2.3.0',
  url: 'https://example.test/r/2.3.0',
  createdBy: 'k_pipeline',
  createdAt: NOW,
};

function ok(data: unknown, status = 200): Response {
  return {
    status,
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
  } as unknown as Response;
}

function refused(status: number, code: string): Response {
  return {
    status,
    ok: false,
    json: () => Promise.resolve({ success: false, error: { code, message: 'Refused.' } }),
  } as unknown as Response;
}

interface Calls {
  posts: unknown[];
  deletes: string[];
  lists: number;
}

function serve(routes: { create?: () => Response; list?: () => Response } = {}): Calls {
  const calls: Calls = { posts: [], deletes: [], lists: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        calls.posts.push(JSON.parse(String(init.body)));
        return Promise.resolve((routes.create ?? (() => ok({ annotation: DEPLOY }, 201)))());
      }
      if (init?.method === 'DELETE') {
        calls.deletes.push(url);
        return Promise.resolve(ok({ deleted: true }));
      }
      calls.lists += 1;
      return Promise.resolve((routes.list ?? (() => ok({ annotations: [DEPLOY] })))());
    }),
  );
  return calls;
}

function show(role: 'owner' | 'editor' | 'viewer', close = (): void => {}): JSX.Element {
  const client = createClient({ fetch: globalThis.fetch });
  const value: AppContextValue = {
    client,
    me: {
      actor: { kind: 'session', id: 'u_1' },
      user: null,
      sites: [SITE],
      teams: [{ id: 'default', name: 'Default', role }],
    },
    site: SITE,
    now: NOW,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <NotesPanel close={close} />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('instantOf', () => {
  it('reads a date and a clock time in the site zone', () => {
    // Midnight in Dhaka is 18:00 UTC the evening before.
    expect(instantOf('2026-09-18', '00:00', DHAKA)).toBe(Date.UTC(2026, 8, 17, 18, 0));
    expect(instantOf('2026-09-18', '09:30', DHAKA)).toBe(Date.UTC(2026, 8, 18, 3, 30));
    expect(instantOf('2026-09-18', '09:30', 'UTC')).toBe(Date.UTC(2026, 8, 18, 9, 30));
  });

  it('answers null for anything that is not a date and a time', () => {
    expect(instantOf('', '09:30', DHAKA)).toBeNull();
    expect(instantOf('2026-09-18', '', DHAKA)).toBeNull();
    expect(instantOf('18/09/2026', '09:30', DHAKA)).toBeNull();
    expect(instantOf('2026-09-18', '24:00', DHAKA)).toBeNull();
  });
});

describe('the annotations panel', () => {
  it('lists the marks of the range with their kind, their time and their link', async () => {
    serve();
    render(show('viewer'));
    expect(await screen.findByText('v2.3.0')).toBeInTheDocument();
    expect(screen.getByText('Deploy')).toBeInTheDocument();
    // 01:00 UTC on the 18th is 07:00 in Dhaka.
    expect(screen.getByText('18 Sept, 07:00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the link' })).toHaveAttribute('href', DEPLOY.url);
  });

  it('gives a viewer the list and one sentence, never the form', async () => {
    serve();
    render(show('viewer'));
    expect(await screen.findByText('v2.3.0')).toBeInTheDocument();
    expect(
      screen.getByText('Only an owner or an editor of this site can add or delete a mark.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('What happened')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('lets an editor add a mark at a date and a time in the site zone, then closes', async () => {
    const calls = serve();
    const close = vi.fn();
    const user = userEvent.setup();
    render(show('editor', close));
    expect(await screen.findByText('v2.3.0')).toBeInTheDocument();

    // The form opens on the site's today and the site's clock: 04:00 UTC is
    // 10:00 in Dhaka.
    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-18');
    expect(screen.getByLabelText('Time (Asia/Dhaka)')).toHaveValue('10:00');

    await user.selectOptions(screen.getByLabelText('Kind'), 'campaign');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-18' } });
    fireEvent.change(screen.getByLabelText('Time (Asia/Dhaka)'), { target: { value: '09:30' } });
    await user.type(screen.getByLabelText('What happened'), '  Launch week email  ');
    await user.type(screen.getByLabelText('Link (optional)'), 'https://example.test/launch');
    await user.click(screen.getByRole('button', { name: 'Add the mark' }));

    await waitFor(() => expect(calls.posts).toHaveLength(1));
    expect(calls.posts[0]).toEqual({
      at: dayBounds('2026-09-18', DHAKA).start + 9.5 * 60 * 60_000,
      kind: 'campaign',
      text: 'Launch week email',
      url: 'https://example.test/launch',
    });
    // The list is asked again, and the panel closes.
    await waitFor(() => expect(calls.lists).toBeGreaterThan(1));
    expect(close).toHaveBeenCalled();
  });

  it('asks for a sentence before it posts anything', async () => {
    const calls = serve();
    const user = userEvent.setup();
    render(show('owner'));
    expect(await screen.findByText('v2.3.0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add the mark' }));
    expect(await screen.findByText('This needs a sentence.')).toBeInTheDocument();
    expect(calls.posts).toHaveLength(0);
  });

  it('says when the mark is already there', async () => {
    serve({ create: () => refused(409, 'ANNOTATION_EXISTS') });
    const user = userEvent.setup();
    render(show('owner'));
    expect(await screen.findByText('v2.3.0')).toBeInTheDocument();
    await user.type(screen.getByLabelText('What happened'), 'v2.3.0');
    await user.click(screen.getByRole('button', { name: 'Add the mark' }));
    expect(await screen.findByText('That mark is already there.')).toBeInTheDocument();
  });

  it('deletes a mark after a confirmation', async () => {
    const calls = serve();
    const user = userEvent.setup();
    render(show('editor'));
    expect(await screen.findByText('v2.3.0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/Delete this mark\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(calls.deletes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(calls.deletes).toHaveLength(1));
    expect(calls.deletes[0]).toContain('/api/sites/s_test/annotations/an_deploy');
  });

  it('says so when the range has no marks', async () => {
    serve({ list: () => ok({ annotations: [] }) });
    render(show('viewer'));
    expect(await screen.findByText('No annotations in this range.')).toBeInTheDocument();
  });
});
