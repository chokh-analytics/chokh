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

function person(over: Record<string, unknown> = {}) {
  return {
    visitorId: 'v_abcdef123456',
    firstSeenAt: Date.UTC(2026, 7, 1, 8, 0, 0),
    lastSeenAt: NOW - 5 * 60_000,
    sessions: 9,
    pageviews: 41,
    homeGeo: { country: 'BD', city: 'Dhaka' },
    devices: ['Chrome on Windows'],
    ips: [],
    ...over,
  };
}

function directory(
  people: unknown[] = [],
  next: string | null = null,
  identity = true,
): Response {
  return ok({ people, next }, { identity, limit: 50 });
}

function serve(
  answer: () => Response = () => ok(profile()),
  live: () => Response = () => ok(realtime()),
  list: (url: URL) => Response = () => directory(),
): ReturnType<typeof vi.fn> {
  const fetch = vi.fn((input: string) => {
    const url = new URL(String(input), 'http://chokh.test');
    if (url.pathname.endsWith('/realtime')) return Promise.resolve(live());
    if (url.pathname.endsWith('/people')) return Promise.resolve(list(url));
    return Promise.resolve(answer());
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
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

// The directory (AN-PPL02): everybody, a page at a time, each row a way into
// the profile, the search shut for an account that may not name anybody.
describe('People, the directory', () => {
  function asked(fetch: ReturnType<typeof vi.fn>): URL[] {
    return fetch.mock.calls
      .map((call) => new URL(String(call[0]), 'http://chokh.test'))
      .filter((url) => url.pathname.endsWith('/people'));
  }

  it('lists everybody, named by what identify() said, newest first', async () => {
    serve(undefined, undefined, () =>
      directory([
        person({
          visitorId: 'v_ada',
          userId: 'u_ada',
          traits: { name: 'Ada Lovelace' },
        }),
        person({ visitorId: 'v_bob', userId: 'u_bob' }),
        person({ visitorId: 'v_anon', homeGeo: undefined }),
      ]),
    );
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() => expect(within(list).getByText('Ada Lovelace')).toBeInTheDocument());
    const rows = within(list).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Ada Lovelaceu_ada',
      'u_bobv_bob',
      'Visitorv_anon',
    ]);
    expect(within(list).getAllByText('Dhaka, Bangladesh')).toHaveLength(2);
    expect(within(list).getByText('All 3 shown')).toBeInTheDocument();
  });

  // The list is ordered by last seen and runs back over days, so a row that is
  // not from today carries its day, and its year once that differs.
  it('writes the day on every last sighting that was not today', async () => {
    const wall = Date.now();
    serve(undefined, undefined, () =>
      directory([
        person({ visitorId: 'v_today', lastSeenAt: wall - 5 * 60_000 }),
        person({ visitorId: 'v_yesterday', lastSeenAt: wall - 26 * 60 * 60_000 }),
        person({ visitorId: 'v_old', lastSeenAt: Date.UTC(2024, 2, 5, 8, 0, 0) }),
      ]),
    );
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() => expect(within(list).getByText('v_old')).toBeInTheDocument());
    const seen = within(list)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[1]?.textContent);
    expect(seen[0]).toBe('5m');
    expect(seen[1]).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d\d:\d\d$/);
    expect(seen[2]).toBe('5 Mar 2024, 08:00');
  });

  it('opens the profile from a row, by the keyboard as well as the mouse', async () => {
    serve(undefined, undefined, () => directory([person()]));
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    const link = await within(list).findByRole('link', { name: /Visitor/ });
    link.focus();
    await userEvent.keyboard('{Enter}');
    expect(window.location.pathname).toBe('/s_test/people/v/v_abcdef123456');
  });

  it('names nobody and shuts the search for an account without the permission', async () => {
    serve(undefined, undefined, () => directory([person({ visitorId: 'v_x' })], null, false));
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() => expect(within(list).getByLabelText('Search')).toBeDisabled());
    expect(within(list).getByText(/needs the read:identity permission\. The list itself/)).toBeInTheDocument();
    expect(within(list).getByRole('switch')).toBeEnabled();
  });

  it('searches as somebody types, once, and keeps it in the address', async () => {
    const fetch = serve(undefined, undefined, (url) =>
      url.searchParams.get('q') === 'ada'
        ? directory([person({ visitorId: 'v_ada', userId: 'u_ada' })])
        : directory([person(), person({ visitorId: 'v_other' })]),
    );
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() => expect(within(list).getByText('All 2 shown')).toBeInTheDocument());
    await userEvent.type(within(list).getByLabelText('Search'), 'ada');
    await waitFor(() => expect(within(list).getByText('u_ada')).toBeInTheDocument());

    const searches = asked(fetch).filter((url) => url.searchParams.has('q'));
    expect(searches.map((url) => url.searchParams.get('q'))).toEqual(['ada']);
    expect(window.location.search).toBe('?q=ada');
  });

  it('keeps to the identified when the switch is on', async () => {
    const fetch = serve(undefined, undefined, (url) =>
      url.searchParams.get('identifiedOnly') === 'true'
        ? directory([person({ userId: 'u_named' })])
        : directory([person(), person({ visitorId: 'v_other' })]),
    );
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() => expect(within(list).getByText('All 2 shown')).toBeInTheDocument());
    await userEvent.click(within(list).getByRole('switch', { name: 'Only people you identified' }));
    await waitFor(() => expect(within(list).getByText('u_named')).toBeInTheDocument());
    expect(within(list).getByRole('switch')).toBeChecked();
    expect(asked(fetch).some((url) => url.searchParams.get('identifiedOnly') === 'true')).toBe(true);
    expect(window.location.search).toBe('?named=1');
  });

  it('shows more from the cursor the page before handed out', async () => {
    const fetch = serve(undefined, undefined, (url) =>
      url.searchParams.get('cursor') === 'c_2'
        ? directory([person({ visitorId: 'v_second' })])
        : directory([person({ visitorId: 'v_first' })], 'c_2'),
    );
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() => expect(within(list).getByText('Showing 1')).toBeInTheDocument());
    await userEvent.click(within(list).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list).getByText('All 2 shown')).toBeInTheDocument());
    expect(within(list).getByText('v_first')).toBeInTheDocument();
    expect(within(list).getByText('v_second')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(asked(fetch).map((url) => url.searchParams.get('cursor'))).toEqual([null, 'c_2']);
  });

  it('says so when nobody matches, and clears the search from there', async () => {
    at('/s_test/people?q=zz');
    serve(undefined, undefined, (url) =>
      url.searchParams.has('q') ? directory([]) : directory([person()]),
    );
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() => expect(within(list).getByText('Nobody matches "zz".')).toBeInTheDocument());
    await userEvent.click(within(list).getByRole('button', { name: 'Clear the search' }));
    await waitFor(() => expect(within(list).getByText('All 1 shown')).toBeInTheDocument());
    expect(window.location.search).toBe('');
  });

  it('says so when the site has nobody yet', async () => {
    serve();
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() =>
      expect(within(list).getByText(/Nobody has been seen on this site yet/)).toBeInTheDocument(),
    );
  });

  it('reports a refusal in the card rather than an empty list', async () => {
    serve(undefined, undefined, () => refused('SCOPE_REQUIRED', 'Searching people needs read:identity'));
    render(show());

    const list = await screen.findByRole('region', { name: 'Everybody' });
    await waitFor(() => expect(within(list).getByRole('alert')).toBeInTheDocument());
    expect(within(list).getByText('Searching people needs read:identity')).toBeInTheDocument();
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

  // AN-PPL01, carried from AN-DSH01: how many of their visits opened there,
  // out of all of them, when the server counted it.
  it('says how many of their visits opened in the home place', async () => {
    at('/s_test/people/v/v_abcdef123456');
    serve(() => ok(profile({ homeVisits: 7 })));
    render(show());
    const facts = await screen.findByRole('region', { name: 'Profile' });
    await waitFor(() =>
      expect(within(facts).getByText('Dhaka, Bangladesh, 7 of 9 visits')).toBeInTheDocument(),
    );
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

    await userEvent.click(screen.getByRole('button', { name: 'Back to everybody' }));
    expect(window.location.pathname).toBe('/s_test/people');
    expect(card('Everybody')).toBeInTheDocument();
  });
});
