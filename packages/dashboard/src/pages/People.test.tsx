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
    routeGroups: [],
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
    // Two stays: two things on the 19th, one the day before. Every event
    // carries the stay ingest stamped it with.
    timeline: [
      { ts: Date.UTC(2026, 8, 19, 17, 30, 0), type: 'pageview', path: '/pricing', sessionId: 's_2' },
      { ts: Date.UTC(2026, 8, 19, 17, 28, 0), type: 'event', name: 'signup', sessionId: 's_2' },
      { ts: Date.UTC(2026, 8, 18, 9, 0, 0), type: 'pageview', path: '/docs', sessionId: 's_1' },
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

function realtime(over: Record<string, unknown> = {}) {
  return {
    online: 0,
    signedIn: 0,
    anonymous: 0,
    byPage: [],
    byCountry: [],
    byCity: [],
    visitors: [],
    recent: [],
    ...over,
  };
}

function present(over: Record<string, unknown> = {}) {
  return {
    visitorId: 'v_abcdef123456',
    sessionId: 's_now',
    since: NOW - 300_000,
    lastSeenAt: NOW - 10_000,
    path: '/pricing',
    country: 'BD',
    city: 'Dhaka',
    browser: 'Chrome',
    os: 'Android',
    device: 'mobile',
    ...over,
  };
}

function serve(
  answer: () => Response = () => ok(profile()),
  live: () => Response = () => ok(realtime()),
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) =>
      Promise.resolve(String(input).includes('/realtime') ? live() : answer()),
    ),
  );
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

  // A search box with nothing beside it only works for somebody who already has
  // an id to paste, and nobody has one.
  it('lists everybody seen in the last half hour under the box', async () => {
    serve(
      () => ok(profile()),
      () =>
        ok(
          realtime({
            online: 1,
            anonymous: 1,
            visitors: [present()],
            recent: [present({ visitorId: 'v_earlier', path: '/docs' })],
          }),
        ),
    );
    render(show());

    const here = await screen.findByRole('region', { name: 'Here in the last half hour' });
    await waitFor(() => expect(within(here).getByText('/pricing')).toBeInTheDocument());
    expect(within(here).getByText('/docs')).toBeInTheDocument();
    expect(within(here).getByText('Seen in the last 30 minutes')).toBeInTheDocument();
  });

  it('opens a profile from a row of that list', async () => {
    serve(
      () => ok(profile()),
      () => ok(realtime({ online: 1, anonymous: 1, visitors: [present()] })),
    );
    render(show());

    const here = await screen.findByRole('region', { name: 'Here in the last half hour' });
    await waitFor(() => expect(within(here).getByText('/pricing')).toBeInTheDocument());
    await userEvent.click(within(here).getByRole('button', { name: /Visitor/ }));

    expect(window.location.pathname).toBe('/s_test/people/v/v_abcdef123456');
  });

  it('says so when nobody has been here', async () => {
    serve();
    render(show());

    const here = await screen.findByRole('region', { name: 'Here in the last half hour' });
    await waitFor(() =>
      expect(
        within(here).getByText('Nobody has been on the site in the last half hour.'),
      ).toBeInTheDocument(),
    );
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
  // A pair of coordinates is for putting a dot on a map, and there is no map on
  // a profile: printed beside somebody's name it reads as a position rather
  // than a place, which is a different claim about a person.
  it('names the place and prints no coordinates', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve();
    render(show());

    const facts = await screen.findByRole('region', { name: 'Profile' });
    await waitFor(() =>
      expect(within(facts).getByText('Dhaka, Bangladesh')).toBeInTheDocument(),
    );
    expect(within(facts).queryByText(/23\.81/)).toBeNull();
    expect(within(facts).queryByText(/90\.41/)).toBeNull();
    // And nothing the geo database stored at full precision.
    expect(within(facts).queryByText(/23\.8103456/)).toBeNull();
  });

  it('has no address row when the server sent no addresses', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve();
    render(show());

    await screen.findByText('Dhaka, Bangladesh');
    expect(screen.queryByText('Addresses')).toBeNull();
  });

  it('shows the addresses when the server sent them, and says the look was logged', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve(() => ok(profile({ ips: ['203.0.113.9'] }), { identity: true }));
    render(show());

    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('This lookup was written to the audit log.')).toBeInTheDocument();
  });

  // Fifty rows of pageviews is a log, and a log is what an analytics product
  // gives you instead of an answer. Four visits is the shape of the thing.
  it('groups the timeline into the stays it actually was', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve();
    render(show());

    const timeline = await screen.findByRole('region', { name: 'What they did' });
    // Two stays from three events, the most recent one open. Found by what the
    // head says rather than by counting buttons, because the card's help dot is
    // a button too.
    const heads = (): HTMLElement[] =>
      within(timeline).getAllByRole('button', { name: /what happened/i });
    await waitFor(() => expect(heads()).toHaveLength(2));
    const stays = heads();
    expect(stays[0]).toHaveAttribute('aria-expanded', 'true');
    expect(stays[1]).toHaveAttribute('aria-expanded', 'false');
    expect(stays[0]).toHaveTextContent('2 things');

    // The open one shows what happened in it; the shut one does not.
    expect(within(timeline).getByText('/pricing')).toBeInTheDocument();
    expect(within(timeline).queryByText('/docs')).toBeNull();

    await userEvent.click(stays[1] as HTMLElement);
    expect(within(timeline).getByText('/docs')).toBeInTheDocument();
  });

  it('keeps a row with no stay on it rather than dropping it', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve(() =>
      ok(
        profile({
          timeline: [
            { ts: Date.UTC(2026, 8, 19, 17, 30, 0), type: 'pageview', path: '/old' },
            { ts: Date.UTC(2026, 8, 19, 17, 28, 0), type: 'pageview', path: '/older' },
          ],
        }),
      ),
    );
    render(show());

    const timeline = await screen.findByRole('region', { name: 'What they did' });
    // A row written before ingest stamped stays becomes a stay of its own
    // rather than joining somebody else's.
    await waitFor(() =>
      expect(within(timeline).getAllByRole('button', { name: /what happened/i })).toHaveLength(2),
    );
  });

  it('says they are here now, and what they are reading', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve(
      () => ok(profile()),
      () => ok(realtime({ online: 1, anonymous: 1, visitors: [present()] })),
    );
    render(show());

    const facts = await screen.findByRole('region', { name: 'Profile' });
    // The live line, which carries both words: the facts list below has a
    // "Last seen" label of its own, so this matches the sentence and not the
    // label.
    await waitFor(() =>
      expect(within(facts).getByText(/Online now.*Reading \/pricing/)).toBeInTheDocument(),
    );
    expect(within(facts).queryByText(/Last seen \S/)).toBeNull();
  });

  it('says when they were last seen when they are not here', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve();
    render(show());

    const facts = await screen.findByRole('region', { name: 'Profile' });
    await waitFor(() => expect(within(facts).getByText(/Last seen \S/)).toBeInTheDocument());
    expect(within(facts).queryByText(/Online now/)).toBeNull();
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
