import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from './context.js';
import { createClient } from '../lib/client.js';
import { Shortcuts, groupsFor } from './shortcuts.js';
import { destinationsFor } from './Shell.js';

// The keys, and the three ways a shortcut layer becomes a nuisance.
//
// A dashboard with a text field and a bare "g" binding eats the g out of
// anything anybody types into it. A sequence with no timeout lies in wait, so
// the letter pressed a minute after a stray "g" goes somewhere nobody asked
// for. And a binding that takes ctrl+r takes reload, which is worse than not
// having the binding.

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

function show(): JSX.Element {
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: { actor: { kind: 'session', id: 'u_1' }, user: null, sites: [SITE], teams: [] },
    site: SITE,
    now: NOW,
  };
  return (
    <AppContext.Provider value={value}>
      {/* Something focusable that takes typing, so the "not while typing" rule
          has a real field to be tested against. */}
      <input aria-label="a field" />
      <Shortcuts />
    </AppContext.Provider>
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the keys', () => {
  it('goes to a report on g then a letter', async () => {
    render(show());
    await userEvent.keyboard('gp');
    expect(window.location.pathname).toBe('/s_test/pages');
  });

  it('sets a range preset', async () => {
    render(show());
    await userEvent.keyboard('t');
    expect(window.location.search).toContain('range=today');
  });

  it('turns the comparison off and on again', async () => {
    render(show());
    await userEvent.keyboard('c');
    expect(window.location.search).toContain('compare=off');
    await userEvent.keyboard('c');
    expect(window.location.search).not.toContain('compare=off');
  });

  // The one that matters most: a person typing a path into a filter must not
  // navigate away halfway through the word.
  it('fires nothing while somebody is typing', async () => {
    render(show());
    await userEvent.click(screen.getByLabelText('a field'));
    await userEvent.keyboard('gpt');
    expect(window.location.pathname).toBe('/s_test');
    expect(screen.getByLabelText('a field')).toHaveValue('gpt');
  });

  it('leaves the browser its own keys', async () => {
    render(show());
    await userEvent.keyboard('{Control>}t{/Control}');
    expect(window.location.search).not.toContain('range=today');
  });

  it('forgets a prefix that was never finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(show());
    const keyboard = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await keyboard.keyboard('g');
    vi.advanceTimersByTime(2_000);
    // A lone "t" after the prefix has expired is the range preset, not the
    // second half of a navigation.
    await keyboard.keyboard('t');

    expect(window.location.pathname).toBe('/s_test');
    expect(window.location.search).toContain('range=today');
    vi.useRealTimers();
  });
});

describe('the card that lists them', () => {
  it('opens on ? and closes on Escape', async () => {
    render(show());
    await userEvent.keyboard('?');
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(sheet).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull(),
    );
  });

  // The card is built from the same list the navigation is, so a report added
  // to one cannot be missing from the other.
  it('lists every destination the navigation has', () => {
    const rows = groupsFor('s_test').flatMap((group) => group.rows);
    for (const destination of destinationsFor('s_test')) {
      expect(rows.some((row) => row.label === destination.label)).toBe(true);
    }
  });

  it('gives every destination a key of its own', () => {
    const go = groupsFor('s_test')[0];
    const keys = (go?.rows ?? []).map((row) => row.keys.join(''));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.length === 2)).toBe(true);
  });
});
