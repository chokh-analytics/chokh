import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { createQueryClient } from '../lib/queries.js';
import { NOW_TICK_MS, roundedNow, useNow } from './useNow.js';

// The four things that can be true the moment GET /api/me answers, and the one
// route that decides which of them a person sees.
//
// The site root is the most visited path in this product and it is also the one
// a router gets wrong quietly: a wildcard segment does not match its own
// absence, so a pattern written for everything under a site misses the site
// itself, and the fallback redirects it to itself for ever while the page
// renders nothing at all. No error, no log, no clue. That is the case at the
// bottom of this file.

const SITE = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
  teamId: 'default',
  settings: {
    ipMode: 'anonymized' as const,
    visitorIdMode: 'cookieless' as const,
    botFilter: true,
    retentionDays: 180,
    timezone: 'Asia/Dhaka',
    allowUnsignedIdentify: true,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
    routeGroups: [],
  },
};

function envelope(data: unknown, status = 200): Response {
  return {
    status,
    ok: status < 400,
    json: () => Promise.resolve(status < 400 ? { success: true, data } : data),
  } as unknown as Response;
}

function refusal(status: number, code: string): Response {
  return {
    status,
    ok: false,
    json: () => Promise.resolve({ success: false, error: { code, message: code } }),
  } as unknown as Response;
}

// The application builds its own client from import.meta.env, so the seam here
// is fetch itself. Every route it can reach answers from this one table.
function serve(routes: Record<string, () => Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = String(input).split('?')[0] ?? '';
      const handler = routes[path];
      return Promise.resolve(handler === undefined ? refusal(404, 'NOT_FOUND') : handler());
    }),
  );
}

function at(path: string): void {
  window.history.replaceState(null, '', path);
}

beforeEach(() => {
  at('/');
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('who sees what', () => {
  it('shows the sign in card to somebody with no session', async () => {
    serve({ '/api/me': () => refusal(401, 'UNAUTHENTICATED') });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeDefined();
  });

  // A deep link somebody was sent, followed after a session expired. They land
  // on the form rather than on a page of failed cards.
  it('shows it for a deep link too, rather than a broken report', async () => {
    at('/s_test/sources?range=30d');
    serve({ '/api/me': () => refusal(401, 'UNAUTHENTICATED') });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeDefined();
  });

  // And it lands on /login carrying where it was going, rather than drawing the
  // form at the report's own URL. A form at /s_test/sources is a page nobody
  // can link to, a reload that lands on the form again, and a sign-in that has
  // to guess where to go next.
  it('sends a deep link to the sign in page, carrying where it was going', async () => {
    at('/s_test/sources?range=30d');
    serve({ '/api/me': () => refusal(401, 'UNAUTHENTICATED') });
    render(<App />);

    await screen.findByRole('button', { name: 'Sign in' });
    expect(window.location.pathname).toBe('/login');
    expect(decodeURIComponent(window.location.search)).toBe('?next=/s_test/sources?range=30d');
  });

  // An install that has just been started. Without this screen somebody signs
  // in and looks at nothing, with no way forward that is not the README.
  it('offers the first site to an account that can read none', async () => {
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'a@b.c' },
          sites: [],
          teams: [{ id: 't_theirs', name: 'Theirs', role: 'owner' }],
        }),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Add a site' })).toBeDefined();
  });

  it('draws the shell around a site somebody can read', async () => {
    at('/s_test');
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test', name: 'Abu Jafar' },
          sites: [SITE],
          teams: [],
        }),
    });
    render(<App />);
    // The site root renders its report rather than redirecting to itself.
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Realtime' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
  });

  // A gated feature is described, never simulated and never hidden, and the
  // licence itself is said out loud in the one menu that is about this install
  // rather than about the numbers. Both states, because the line an install
  // with no key reads is the one that matters most: the core is the whole
  // product for most people and the menu should say so.
  it('says in the account menu what this install is running', async () => {
    at('/s_test');
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test', name: 'Abu Jafar' },
          sites: [SITE],
          teams: [],
        }),
      '/api/license': () =>
        envelope({
          licensed: true,
          plan: 'pro',
          licensee: 'Progsity, BWJ Tech Ltd.',
          expiresAt: Date.UTC(2028, 8, 20),
          features: ['*'],
        }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Abu Jafar' }));
    expect(
      await screen.findByText('Chokh Pro, licensed to Progsity, BWJ Tech Ltd.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Until 20 September 2028')).toBeInTheDocument();
  });

  it('tells an install with no licence that what it has is free for ever', async () => {
    at('/s_test');
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test', name: 'Abu Jafar' },
          sites: [SITE],
          teams: [],
        }),
      '/api/license': () =>
        envelope({
          licensed: false,
          plan: null,
          licensee: null,
          expiresAt: null,
          features: [],
        }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Abu Jafar' }));
    expect(await screen.findByText(/free to self-host, for ever/)).toBeInTheDocument();
  });

  // The failure that has no symptom: the page stays blank and nothing is
  // logged, because a redirect to the current path is not an error.
  it('never redirects the site root to itself', async () => {
    at('/s_test');
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [SITE],
          teams: [],
        }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(window.location.pathname).toBe('/s_test');
  });

  it('marks the page somebody is on, and only that one', async () => {
    at('/s_test/pages');
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [SITE],
          teams: [],
        }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Pages' });
    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent)).toEqual(['Pages']);
  });

  // A link to a site this account cannot read is a dead end if it refuses. The
  // switcher is right there, so it falls back to a site they can read.
  it('falls back to a site they can read rather than refusing a link', async () => {
    at('/s_somebody_elses');
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [SITE],
          teams: [],
        }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(screen.getByRole('button', { name: /Progsity/ })).toBeDefined();
  });

  // Somebody signed in who follows a stale sign in link wants their numbers,
  // not a form they do not need.
  it('sends a signed in person away from the sign in page', async () => {
    at('/login');
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [SITE],
          teams: [],
        }),
    });
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/s_test'));
  });
});

// The session, which is the half of this that nobody sees working and everybody
// sees failing.
describe('a session that ends', () => {
  const ME = {
    actor: { kind: 'session', id: 'u_1' },
    user: { id: 'u_1', email: 'owner@chokh.test' },
    sites: [SITE],
    teams: [],
  };

  // The interceptor used to call setQueryData(['me'], undefined), which
  // TanStack ignores, so a session that expired mid visit left every card on
  // the page reporting UNAUTHENTICATED at somebody who could do nothing about
  // it from there.
  it('sends an expired session to sign in, carrying where it was', async () => {
    at('/s_test?range=30d');
    let expired = false;
    serve({
      '/api/me': () => (expired ? refusal(401, 'UNAUTHENTICATED') : envelope(ME)),
      // The session ends while a report is on screen, which is the case that
      // matters: the cards were all that noticed, and all they could do was
      // say UNAUTHENTICATED at somebody who could do nothing about it there.
      '/api/sites/s_test/stats/aggregate': () => {
        expired = true;
        return refusal(401, 'UNAUTHENTICATED');
      },
    });
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(new URLSearchParams(window.location.search).get('next')).toBe('/s_test?range=30d');
  });

  // The other half of the same fix: after signing in, back to the report they
  // were reading rather than to whichever site happens to be first.
  it('returns to where they were once they are back in', async () => {
    at('/login?next=%2Fs_test%2Fdevices');
    serve({
      '/api/me': () => envelope(ME),
      '/api/auth/login': () => envelope({ user: ME.user }),
    });
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/s_test/devices'));
  });

  // Without this the next account at the same browser is served the previous
  // person's rows while their own load, which on a site with read:identity is
  // somebody else's addresses.
  it('empties the cache on the way out', async () => {
    at('/s_test');
    let signedIn = true;
    serve({
      '/api/me': () => (signedIn ? envelope(ME) : refusal(401, 'UNAUTHENTICATED')),
      '/api/auth/logout': () => {
        signedIn = false;
        return envelope({ signedOut: true });
      },
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(document.body.textContent).toContain('Progsity');

    await userEvent.click(screen.getByRole('button', { name: /owner@chokh.test/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    // Nothing of the previous account is left on the page. Without the clear,
    // the site they could read is still in the cache and still on screen while
    // the next person's own sites load.
    await waitFor(() => expect(document.body.textContent).not.toContain('Progsity'));
  });
});

// Every range in this dashboard is resolved against now. Read once at render,
// it stops the moment the page settles, and a dashboard left open all afternoon
// keeps asking about the same window while Online now, which polls on its own,
// keeps moving.
describe('the clock', () => {
  it('rounds to the tick, so a key changes once a minute and not every render', () => {
    const at = Date.UTC(2026, 8, 18, 4, 30, 41, 512);
    expect(roundedNow(at)).toBe(Date.UTC(2026, 8, 18, 4, 31, 0, 0));
    expect(roundedNow(at + 1_000)).toBe(roundedNow(at));
    expect(roundedNow(at + 60_000)).toBe(Date.UTC(2026, 8, 18, 4, 32, 0, 0));
  });

  // Flooring puts every report's window up to fifty nine seconds in the past,
  // so a pageview that has just landed is outside it: the live tile says one
  // person is online and the Visitors tile says nobody came, for a minute, on
  // the screen a new install is watching.
  it('never ends a window in the past', () => {
    for (const offset of [0, 1, 17_000, 41_512, 59_999]) {
      const at = Date.UTC(2026, 8, 18, 4, 30, 0) + offset;
      expect(roundedNow(at)).toBeGreaterThanOrEqual(at);
    }
  });

  it('advances the window a report asks about', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 8, 18, 4, 0, 30));
      const { result } = renderHook(() => useNow());
      const first = result.current;

      act(() => {
        vi.setSystemTime(Date.UTC(2026, 8, 18, 4, 2, 5));
        vi.advanceTimersByTime(NOW_TICK_MS * 2);
      });
      expect(result.current).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Two promises the markup was making and could not keep.
describe('what the controls claim to be', () => {
  const ME = {
    actor: { kind: 'session', id: 'u_1' },
    user: { id: 'u_1', email: 'owner@chokh.test' },
    sites: [SITE],
    teams: [],
  };

  // aria-haspopup="menu" promises a menu widget with arrow key navigation, and
  // a screen reader tells somebody to use keys that do nothing here: what opens
  // is a group of buttons.
  it('never calls a group of buttons a menu', async () => {
    at('/s_test');
    serve({ '/api/me': () => envelope(ME) });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });

    const triggers = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-haspopup'));
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      expect(trigger.getAttribute('aria-haspopup')).toBe('true');
    }
  });

  // The group holds Today, Yesterday, 7 days and 30 days, which is a date
  // range. It was announced as "Interval", which is the bucket size and is a
  // different control that does not exist yet.
  it('calls the preset group what it is', async () => {
    at('/s_test');
    serve({ '/api/me': () => envelope(ME) });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(screen.getByRole('group', { name: 'Date range' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Interval' })).toBeNull();
  });
});

// The one screen a fresh install gives somebody, and the two ways it refused
// them.
describe('adding the first site', () => {
  function firstRun(teams: unknown[]): void {
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [],
          teams,
        }),
      '/api/sites': () =>
        envelope({
          site: { ...SITE, id: 's_new' },
          identifySecret: 'shown-once',
          once: 'identifySecret',
        }),
    });
  }

  // Posting nothing meant the server's default, which is the team called
  // default, and an owner the SSO exchange provisioned owns a team of their own
  // instead: "Only an owner of default may create a site in it", on the only
  // screen they had.
  it('creates the site in a team this person actually owns', async () => {
    firstRun([{ id: 't_theirs', name: 'Theirs', role: 'owner' }]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Add a site' });

    await userEvent.type(screen.getByLabelText('Name'), 'Progsity');
    await userEvent.type(screen.getByLabelText('Domain'), 'progsity.io');
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    await waitFor(() => {
      const posted = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url]) => String(url) === '/api/sites');
      expect(posted).toBeDefined();
      expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({ teamId: 't_theirs' });
    });
  });

  it('names no team when this person owns none, and lets the server decide', async () => {
    firstRun([{ id: 't_someone_elses', name: 'Theirs', role: 'viewer' }]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Add a site' });

    await userEvent.type(screen.getByLabelText('Name'), 'Progsity');
    await userEvent.type(screen.getByLabelText('Domain'), 'progsity.io');
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    await waitFor(() => {
      const posted = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url]) => String(url) === '/api/sites');
      expect(JSON.parse(String(posted?.[1]?.body))).not.toHaveProperty('teamId');
    });
  });

  // A free text zone accepts "Dhaka" or "GMT+6", and the site is then refused
  // or, worse, created with a zone that means something else for ever.
  it('offers the zones rather than asking somebody to spell one', async () => {
    firstRun([{ id: 't_theirs', name: 'Theirs', role: 'owner' }]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Add a site' });

    const zone = screen.getByLabelText('Timezone');
    expect(zone.tagName).toBe('SELECT');
    expect(zone.querySelectorAll('option').length).toBeGreaterThan(100);
  });
});

// The one chance anybody has to keep the secret that signs an identify.
describe('the secret a site is created with', () => {
  it('prints it, with a way to copy it', async () => {
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [],
          teams: [{ id: 't_theirs', name: 'Theirs', role: 'owner' }],
        }),
      '/api/sites': () =>
        envelope({
          site: { ...SITE, id: 's_new' },
          // The shape the server actually answers with. Read as a flat field it
          // is undefined, and the card promising to show it once showed nothing.
          once: { identifySecret: 'sec_abc123_shown_once' },
        }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Add a site' });
    await userEvent.type(screen.getByLabelText('Name'), 'Progsity');
    await userEvent.type(screen.getByLabelText('Domain'), 'progsity.io');
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    expect(await screen.findByText('sec_abc123_shown_once')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the secret' })).toBeInTheDocument();
  });

  // One owned team is posted silently because there is no choice to offer.
  // Several is a choice, and a site cannot be moved afterwards.
  it('asks which team when somebody owns more than one', async () => {
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [],
          teams: [
            { id: 't_one', name: 'One', role: 'owner' },
            { id: 't_two', name: 'Two', role: 'owner' },
            { id: 't_theirs', name: 'Theirs', role: 'viewer' },
          ],
        }),
      '/api/sites': () =>
        envelope({ site: { ...SITE, id: 's_new' }, once: { identifySecret: 's' } }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Add a site' });

    const picker = screen.getByLabelText('Team');
    expect(picker.tagName).toBe('SELECT');
    // Only the ones they own: a site created into somebody else's team is a
    // site they did not ask for and cannot delete.
    expect([...picker.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'One',
      'Two',
    ]);

    await userEvent.selectOptions(picker, 't_two');
    await userEvent.type(screen.getByLabelText('Name'), 'Progsity');
    await userEvent.type(screen.getByLabelText('Domain'), 'progsity.io');
    await userEvent.click(screen.getByRole('button', { name: 'Add the site' }));

    await waitFor(() => {
      const posted = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url]) => String(url) === '/api/sites');
      expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({ teamId: 't_two' });
    });
  });

  it('offers no team picker to somebody who owns one', async () => {
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [],
          teams: [{ id: 't_one', name: 'One', role: 'owner' }],
        }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Add a site' });
    expect(screen.queryByLabelText('Team')).toBeNull();
  });
});

// A report that has gone stale while somebody was on another page asks again
// when they come back to it, which is the one moment a page has to.
describe('when a report asks again', () => {
  it('refetches on mount rather than showing what it had', async () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries?.refetchOnMount).toBe(true);
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(true);
    // And never behind a hidden tab: a dashboard left open overnight is not a
    // load test.
    expect(client.getDefaultOptions().queries?.refetchIntervalInBackground).toBe(false);
  });
});

// The list somebody opens to answer "which of my sites has people on it right
// now". A column of names in the order the API happened to return them cannot
// answer it, and neither can a list that only says the names.
// A profile link is four segments deep, and the wildcard that carries every
// other report has to carry that one too. It did not: a named wildcard matched
// one segment, so /s/people/v/<id> matched nothing, the fallback redirected to
// the site root, and a link somebody was sent opened the Overview with no
// error anywhere. The same silence as the site root case at the bottom of this
// file, one route further in.
describe('a link that is several segments deep', () => {
  it('opens the profile rather than redirecting to the site root', async () => {
    at('/s_test/people/v/v_abc123');
    serve({
      '/api/me': () =>
        envelope({
          actor: { kind: 'session', id: 'u_1' },
          user: { id: 'u_1', email: 'owner@chokh.test' },
          sites: [SITE],
          teams: [],
        }),
      '/api/sites/s_test/visitors/v_abc123': () =>
        envelope({
          siteId: 's_test',
          visitorId: 'v_abc123',
          firstSeenAt: 0,
          lastSeenAt: 0,
          pageviews: 3,
          events: 0,
          sessions: 1,
          devices: [],
          ips: [],
          timeline: [],
        }),
    });
    render(<App />);

    expect(await screen.findByRole('region', { name: 'Profile' })).toBeDefined();
    expect(window.location.pathname).toBe('/s_test/people/v/v_abc123');
  });
});

describe('the site switcher', () => {
  const OTHERS = [
    { ...SITE, id: 's_zulu', name: 'Zulu', domains: ['zulu.test'] },
    SITE,
    { ...SITE, id: 's_alpha', name: 'Alpha', domains: ['alpha.test'] },
  ];

  function serveSwitcher(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        const path = String(input).split('?')[0] ?? '';
        if (path === '/api/me') {
          return Promise.resolve(
            envelope({
              actor: { kind: 'session', id: 'u_1' },
              user: { id: 'u_1', email: 'owner@chokh.test' },
              sites: OTHERS,
              teams: [],
            }),
          );
        }
        if (path.endsWith('/realtime')) {
          const online = path.includes('s_zulu') ? 12 : path.includes('s_alpha') ? 0 : 4;
          return Promise.resolve(envelope({ online, signedIn: 0, anonymous: online }));
        }
        const metrics = {
          visitors: 10,
          pageviews: 20,
          visits: 10,
          bounces: 2,
          bounceRate: 0.2,
          avgDurationMs: 30_000,
        };
        if (path.endsWith('/aggregate')) {
          return Promise.resolve(envelope({ metrics, previous: null }));
        }
        if (path.endsWith('/timeseries')) {
          return Promise.resolve(envelope({ interval: 'day', points: [], previous: null }));
        }
        return Promise.resolve(envelope({ dim: 'page', rows: [] }));
      }),
    );
  }

  it('says how many people are on each site', async () => {
    at('/s_test');
    serveSwitcher();
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: /Progsity/ }));

    const list = await screen.findByRole('group', { name: 'Switch site' });
    await waitFor(() => expect(within(list).getByText('12 online')).toBeDefined());
    expect(within(list).getByText('0 online')).toBeDefined();
  });

  it('puts the site being read first and the rest by name', async () => {
    at('/s_test');
    serveSwitcher();
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: /Progsity/ }));
    const list = await screen.findByRole('group', { name: 'Switch site' });
    await waitFor(() => expect(within(list).getByText('12 online')).toBeDefined());

    const names = within(list)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '');
    expect(names[0]).toContain('Progsity');
    expect(names[1]).toContain('Alpha');
    expect(names[2]).toContain('Zulu');
  });
});

// A link that names a goal waits for the site's goal list before any report
// asks for a number. Without the wait every card asks twice, once without the
// goal and once with it, or asks with a goal deleted since the link was sent
// and draws a page of errors before the list can say so.
describe('a link that names a goal', () => {
  const ME = {
    actor: { kind: 'session', id: 'u_1' },
    user: { id: 'u_1', email: 'owner@chokh.test' },
    sites: [SITE],
    teams: [],
  };
  const GOAL = {
    siteId: 's_test',
    id: 'g_signup',
    kind: 'event',
    match: 'signup',
    name: 'Signed up',
    createdBy: 'u_1',
    createdAt: 0,
  };

  it('asks no report anything until the list has answered, then asks with the goal', async () => {
    at('/s_test?goal=g_signup');
    let answerGoals: () => void = () => undefined;
    const goalsAnswered = new Promise<void>((resolve) => {
      answerGoals = resolve;
    });
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        asked.push(url);
        const path = url.split('?')[0] ?? '';
        if (path === '/api/me') {
          return envelope(ME);
        }
        if (path === '/api/sites/s_test/goals') {
          await goalsAnswered;
          return envelope({ goals: [GOAL] });
        }
        return refusal(404, 'NOT_FOUND');
      }),
    );
    render(<App />);

    expect(await screen.findByRole('status', { name: 'Loading the report' })).toBeDefined();
    expect(asked.some((url) => url.includes('/stats/'))).toBe(false);

    await act(async () => {
      answerGoals();
      await goalsAnswered;
    });
    await waitFor(() => expect(asked.some((url) => url.includes('/stats/aggregate'))).toBe(true));
    const aggregates = asked.filter((url) => url.includes('/stats/aggregate'));
    expect(aggregates.every((url) => url.includes('goal=g_signup'))).toBe(true);
  });
});
