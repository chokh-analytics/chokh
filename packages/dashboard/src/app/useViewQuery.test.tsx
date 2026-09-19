import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppContext, type AppContextValue } from './context.js';
import { createClient } from '../lib/client.js';
import { useViewQuery } from './useViewQuery.js';

// The URL is the state, so every press that changes it is a step somebody can
// walk back through. The corollary is the thing tested here: a press that
// changes nothing must not be a step at all. Selecting the metric that is
// already selected pushed the same URL again, and back then landed on the page
// somebody was already looking at, once per press.

const NOW = Date.UTC(2026, 8, 20, 9, 0, 0);

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
    timezone: 'UTC',
    allowUnsignedIdentify: false,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
  },
};

function Probe(): JSX.Element {
  const { query, set } = useViewQuery();
  return (
    <div>
      <span data-testid="metric">{query.metric}</span>
      <button type="button" onClick={() => set({ ...query, metric: 'pageviews' })}>
        pageviews
      </button>
      <button type="button" onClick={() => set({ ...query, metric: 'visitors' })}>
        visitors
      </button>
    </div>
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
    <AppContext.Provider value={value}>
      <Probe />
    </AppContext.Provider>
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test');
});

describe('useViewQuery', () => {
  it('writes the choice to the URL', async () => {
    render(show());
    await userEvent.click(screen.getByRole('button', { name: 'pageviews' }));
    expect(window.location.search).toBe('?metric=pageviews');
    expect(screen.getByTestId('metric')).toHaveTextContent('pageviews');
  });

  it('adds no history entry for a press that changes nothing', async () => {
    render(show());
    const before = window.history.length;

    // Already on visitors, which is the default and therefore the empty search.
    await userEvent.click(screen.getByRole('button', { name: 'visitors' }));
    await userEvent.click(screen.getByRole('button', { name: 'visitors' }));

    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe('');
  });

  it('adds one entry per press that does change something', async () => {
    render(show());
    const before = window.history.length;

    await userEvent.click(screen.getByRole('button', { name: 'pageviews' }));
    await userEvent.click(screen.getByRole('button', { name: 'pageviews' }));

    expect(window.history.length).toBe(before + 1);
  });
});
