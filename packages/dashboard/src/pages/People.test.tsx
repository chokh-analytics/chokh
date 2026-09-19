import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { Route, Switch } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { People } from './People.js';

// The report that names somebody, and the three promises it has to keep.
//
// The home location is rounded before it is drawn, because ingest wrote it at
// whatever precision the geo database gave and a profile page is the one place
// that number reaches a screen. The address row exists only when the server
// sent addresses, so an account without read:identity sees no row rather than
// an empty one that would read as "this person has no address". And the page
// says the lookup was logged, because an audit log the subject of it cannot see
// is a promise rather than a protection.

const NOW = Date.UTC(2026, 8, 20, 9, 0, 0);

const SITE = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
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
  },
};

function profile(over: Record<string, unknown> = {}) {
  return {
    siteId: SITE.id,
    visitorId: 'v_abcdef123456',
    firstSeenAt: Date.UTC(2026, 7, 1, 8, 0, 0),
    lastSeenAt: Date.UTC(2026, 8, 19, 17, 30, 0),
    pageviews: 41,
    events: 6,
    sessions: 9,
    // Seven decimals, the way a geo database hands them over.
    homeGeo: { country: 'BD', city: 'Dhaka', lat: 23.8103456, lon: 90.4125123 },
    devices: ['Chrome on Windows'],
    ips: [],
    firstTouch: { channel: 'organic', referrer: 'google.com' },
    timeline: [
      { ts: Date.UTC(2026, 8, 19, 17, 30, 0), type: 'pageview', path: '/pricing' },
      { ts: Date.UTC(2026, 8, 19, 17, 28, 0), type: 'event', name: 'signup' },
      { ts: Date.UTC(2026, 8, 18, 9, 0, 0), type: 'pageview', path: '/docs' },
    ],
    ...over,
  };
}

function ok(data: unknown, meta?: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data, meta }),
  } as unknown as Response;
}

function refused(code: string, message: string, status = 403): Response {
  return {
    status,
    ok: false,
    json: () => Promise.resolve({ success: false, error: { code, message } }),
  } as unknown as Response;
}

function serve(answer: () => Response = () => ok(profile())): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer())));
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
        <Switch>
          <Route path="/:siteId/people">
            <People />
          </Route>
          <Route path="/:siteId/people/:kind/:id">
            <People />
          </Route>
        </Switch>
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function at(path: string): void {
  window.history.replaceState(null, '', path);
}

function card(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  at('/s_test/people');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('People, looking somebody up', () => {
  it('says which lookup needs the permission before anybody types an id', () => {
    serve();
    render(show());
    expect(screen.getByText(/needs the read:identity permission/)).toBeInTheDocument();
  });

  it('goes to the profile of the id that was typed', async () => {
    serve();
    render(show());

    await userEvent.type(screen.getByLabelText('Visitor'), 'v_abcdef123456');
    await userEvent.click(screen.getAllByRole('button', { name: 'Look up' })[1] as HTMLElement);

    expect(window.location.pathname).toBe('/s_test/people/v/v_abcdef123456');
  });
});

describe('People, one profile', () => {
  it('rounds the home location to two decimals before it is shown', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve();
    render(show());

    const facts = await screen.findByRole('region', { name: 'Profile' });
    await waitFor(() =>
      expect(within(facts).getByText('Dhaka, Bangladesh (23.81, 90.41)')).toBeInTheDocument(),
    );
    // The number ingest actually stored must not reach the screen.
    expect(within(facts).queryByText(/23\.8103456/)).toBeNull();
  });

  it('has no address row when the server sent no addresses', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve();
    render(show());

    await screen.findByText('Dhaka, Bangladesh (23.81, 90.41)');
    expect(screen.queryByText('Addresses')).toBeNull();
  });

  it('shows the addresses when the server sent them, and says the look was logged', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve(() => ok(profile({ ips: ['203.0.113.9'] }), { identity: true }));
    render(show());

    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('This lookup was written to the audit log.')).toBeInTheDocument();
  });

  it('draws the timeline newest first, with the date once per day', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve();
    render(show());

    const timeline = await screen.findByRole('region', { name: 'What they did' });
    await waitFor(() => expect(within(timeline).getByText('/pricing')).toBeInTheDocument());
    const items = within(timeline).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('/pricing');
    expect(items[2]?.textContent).toContain('/docs');
    // Two entries on the 19th, one on the 18th: two date headings, not three.
    expect(within(timeline).getAllByText(/2026$/)).toHaveLength(2);
  });

  // A user lookup names a person, so the server refuses it outright rather than
  // answering a profile with the person taken out. The page has to say what the
  // server said.
  it('reports the refusal rather than an empty profile', async () => {
    at('/s_test/people/u/u_42');
    serve(() =>
      refused('FORBIDDEN', 'This lookup names a person, so it needs the read:identity permission.'),
    );
    render(show());

    expect(
      await screen.findByText(
        'This lookup names a person, so it needs the read:identity permission.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('First seen')).toBeNull();
  });

  it('offers the way back to the lookup', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve();
    render(show());

    await userEvent.click(screen.getByRole('button', { name: 'Look somebody else up' }));
    expect(window.location.pathname).toBe('/s_test/people');
    expect(card('People')).toBeInTheDocument();
  });
});
