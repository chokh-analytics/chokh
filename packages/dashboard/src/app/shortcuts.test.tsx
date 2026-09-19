import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from './context.js';
import { createClient } from '../lib/client.js';
import { Shortcuts, bindingsFor, groupsFrom } from './shortcuts.js';
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

  // Against the table that runs, not against the navigation. A card compared
  // to the navigation proves the destinations are listed and says nothing
  // about the ten other keys, which are exactly the ones a card drifts on.
  it('lists every key that is bound, and binds every key it lists', () => {
    const bound = bindingsFor('s_test', noop());
    const listed = groupsFrom(bound).flatMap((group) =>
      group.rows.map((row) => ({ keys: row.keys.join(' '), label: row.label })),
    );

    expect(listed.map((row) => row.keys).sort()).toEqual(
      bound.map((binding) => binding.keys).sort(),
    );
    for (const binding of bound) {
      const row = listed.find((candidate) => candidate.keys === binding.keys);
      expect(row?.label, `${binding.keys} is listed as something else`).toBe(binding.label);
    }
  });

  it('gives every destination a key of its own', () => {
    const go = groupsFrom(bindingsFor('s_test', noop()))[0];
    const keys = (go?.rows ?? []).map((row) => row.keys.join(''));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.length === 2)).toBe(true);
    // And the navigation is in it: a report added there cannot be missing
    // from the card.
    const labels = (go?.rows ?? []).map((row) => row.label);
    for (const destination of destinationsFor('s_test')) {
      expect(labels).toContain(destination.label);
    }
  });

  // A page that keeps navigating underneath an open dialog is a page that
  // moved while somebody was reading what the keys do.
  it('arms nothing while the card is open', async () => {
    render(show());
    await userEvent.keyboard('?');
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });

    await userEvent.keyboard('gp');

    expect(window.location.pathname).toBe('/s_test');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('shows the prefix while a sequence waits for its second key', async () => {
    render(show());
    await userEvent.keyboard('g');

    const armed = await screen.findByRole('status');
    expect(armed).toHaveTextContent('g');
    expect(armed).toHaveTextContent('then a letter');

    await userEvent.keyboard('p');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});

// The handlers a binding needs, doing nothing. The table's shape is what is
// under test here, not what its entries do.
function noop() {
  return {
    go: () => undefined,
    preset: () => undefined,
    shift: () => undefined,
    compare: () => undefined,
    clearFilters: () => undefined,
    theme: () => undefined,
    help: () => undefined,
  };
}
