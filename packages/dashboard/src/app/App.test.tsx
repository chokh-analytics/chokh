import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

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
