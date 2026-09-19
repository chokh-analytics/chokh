import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
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

  // An install that has just been started. Without this screen somebody signs
  // in and looks at nothing, with no way forward that is not the README.
  it('offers the first site to an account that can read none', async () => {
    serve({
      '/api/me': () =>
        envelope({ actor: { kind: 'session', id: 'u_1' }, user: { id: 'u_1', email: 'a@b.c' }, sites: [] }),
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
        }),
    });
    render(<App />);
    // The site root renders its report rather than redirecting to itself.
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Realtime' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
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
    expect(roundedNow(at)).toBe(Date.UTC(2026, 8, 18, 4, 30, 0, 0));
    expect(roundedNow(at + 1_000)).toBe(roundedNow(at));
    expect(roundedNow(at + 60_000)).toBe(Date.UTC(2026, 8, 18, 4, 31, 0, 0));
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
