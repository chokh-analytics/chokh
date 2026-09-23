import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { Events, eventSnippet } from './Events.js';

// The events report and the property breakdown under it.
//
// Two things here are about what the page says rather than what it draws. An
// empty events list on a site that has never sent one is a site that does not
// know how, so it gets the one line that sends one. And a property is not a
// dimension the store can filter by, so its rows are plain text and the card
// says why. The rest is the rule every report keeps: choosing an event is
// clicking its row, which filters the page, which is a link.

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

const GOAL = {
  siteId: 's_test',
  id: 'g_signup',
  kind: 'event' as const,
  match: 'signup',
  name: 'Signed up',
  createdBy: 'u_1',
  createdAt: NOW - 86_400_000,
};

function ok(data: unknown, meta?: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data, meta }),
  } as unknown as Response;
}

const RAW = { retentionDays: 60, rawOnly: true };

// Ten property names, so eight are tabs and two are behind the picker.
const NAMES = ['plan', 'source', 'quiz', 'step', 'theme', 'lang', 'seat', 'term', 'coupon', 'ab.test'];

interface Answers {
  events?: { key: string; visitors: number; events: number; rate: number | null }[];
  properties?: (event: string, property: string | null) => unknown;
}

function serve(answers: Answers = {}): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn((input: string) => {
    const url = new URL(String(input), 'http://x');
    if (url.pathname.endsWith('/stats/events')) {
      return Promise.resolve(
        ok(
          {
            visitors: 400,
            rows: answers.events ?? [
              { key: 'signup', visitors: 40, events: 52, rate: 0.1 },
              { key: 'checkout_start', visitors: 12, events: 12, rate: 0.03 },
            ],
            rawOnly: true,
          },
          RAW,
        ),
      );
    }
    if (url.pathname.endsWith('/stats/properties')) {
      const event = url.searchParams.get('event') ?? '';
      const property = url.searchParams.get('property');
      const answer =
        answers.properties?.(event, property) ?? {
          event,
          properties: NAMES.map((key, index) => ({ key, events: 50 - index })),
          property: property ?? 'plan',
          visitors: 400,
          rows: [
            { key: property === 'source' ? 'footer' : 'pro', visitors: 30, events: 36, rate: 0.075 },
            { key: '', visitors: 10, events: 16, rate: 0.025 },
          ],
          rawOnly: true,
        };
      return Promise.resolve(ok(answer, RAW));
    }
    return Promise.resolve(ok({ goals: [GOAL] }));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function show(over: Partial<AppContextValue> = {}): JSX.Element {
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: { actor: { kind: 'session', id: 'u_1' }, user: null, sites: [SITE], teams: [] },
    site: SITE,
    now: NOW,
    ...over,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Events />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function card(name: string | RegExp): HTMLElement {
  return screen.getByRole('region', { name });
}

function asked(fetcher: ReturnType<typeof vi.fn>, route: string): URLSearchParams[] {
  return fetcher.mock.calls
    .map(([input]) => new URL(String(input), 'http://x'))
    .filter((url) => url.pathname.endsWith(`/stats/${route}`))
    .map((url) => url.searchParams);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/events');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Events, the list', () => {
  it('lists every event with its people and how many times, read from raw events', async () => {
    serve();
    render(show());

    await waitFor(() => expect(within(card('Events')).getByText('signup')).toBeInTheDocument());
    const row = within(card('Events')).getByText('signup').closest('tr');
    expect(row).toHaveTextContent('40');
    expect(row).toHaveTextContent('52');
    expect(
      within(card('Events')).getByText(
        'Read from raw events, so this report sees back 60 days and no further.',
      ),
    ).toBeInTheDocument();
  });

  it('gives a site that has sent none the one line that sends one', async () => {
    serve({ events: [] });
    render(show());

    expect(await within(card('Events')).findByText('No events in this range.')).toBeInTheDocument();
    expect(
      within(card('Events')).getByText("pa('event', 'signup', { plan: 'pro' });"),
    ).toBeInTheDocument();
  });

  it('chooses an event by filtering the page to it', async () => {
    serve();
    render(show());

    await waitFor(() => expect(within(card('Events')).getByText('signup')).toBeInTheDocument());
    expect(screen.getByText('Choose an event above to see what it carried.')).toBeInTheDocument();

    await userEvent.click(within(card('Events')).getByRole('button', { name: /signup/ }));
    expect(decodeURIComponent(window.location.search)).toBe('?filters=event==signup');
    expect(await screen.findByRole('region', { name: 'Properties of signup' })).toBeInTheDocument();
  });

  it('asks neither read for a goal, which neither can answer', async () => {
    const fetcher = serve();
    window.history.replaceState(null, '', '/s_test/events?goal=g_signup&filters=event%3D%3Dsignup');
    render(show({ goals: [GOAL] }));

    await waitFor(() =>
      expect(within(card('Properties of signup')).getByText('pro')).toBeInTheDocument(),
    );
    expect(asked(fetcher, 'events').every((params) => !params.has('goal'))).toBe(true);
    expect(asked(fetcher, 'properties').every((params) => !params.has('goal'))).toBe(true);
  });
});

describe('Events, the properties of one', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/s_test/events?filters=event%3D%3Dsignup');
  });

  it('breaks the event down by its most used property, with the rest as tabs', async () => {
    const fetcher = serve();
    render(show());

    const properties = await screen.findByRole('region', { name: 'Properties of signup' });
    await waitFor(() => expect(within(properties).getByText('pro')).toBeInTheDocument());
    // Eight tabs and no more, the first one open.
    expect(within(properties).getAllByRole('tab')).toHaveLength(8);
    expect(within(properties).getByRole('tab', { name: 'plan' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // An event that did not carry the property is drawn, as unknown.
    expect(within(properties).getByText('Unknown')).toBeInTheDocument();
    // Nothing named when nothing was chosen: the read picks the most used.
    expect(asked(fetcher, 'properties')[0]?.get('event')).toBe('signup');
    expect(asked(fetcher, 'properties')[0]?.has('property')).toBe(false);
    // Plain text, and the card says why.
    expect(within(properties).getByText('pro').closest('button')).toBeNull();
    expect(
      within(properties).getByText('A property cannot be used as a filter yet.'),
    ).toBeInTheDocument();
  });

  it('opens another property from its tab and keeps it in the link', async () => {
    const fetcher = serve();
    render(show());

    const properties = await screen.findByRole('region', { name: 'Properties of signup' });
    await waitFor(() => expect(within(properties).getByText('pro')).toBeInTheDocument());
    await userEvent.click(within(properties).getByRole('tab', { name: 'source' }));

    expect(new URLSearchParams(window.location.search).get('prop')).toBe('source');
    await waitFor(() => expect(within(properties).getByText('footer')).toBeInTheDocument());
    expect(asked(fetcher, 'properties').some((params) => params.get('property') === 'source')).toBe(
      true,
    );
  });

  it('keeps the names past the eighth behind one button, a dot in a name included', async () => {
    serve();
    render(show());

    const properties = await screen.findByRole('region', { name: 'Properties of signup' });
    await waitFor(() => expect(within(properties).getByText('pro')).toBeInTheDocument());
    expect(within(properties).queryByRole('tab', { name: 'ab.test' })).toBeNull();

    await userEvent.click(within(properties).getByRole('button', { name: 'More properties' }));
    await userEvent.click(screen.getByRole('button', { name: 'ab.test' }));
    expect(new URLSearchParams(window.location.search).get('prop')).toBe('ab.test');
  });

  it('says so, with the line that sends one, when the event carried nothing', async () => {
    serve({
      properties: (event) => ({
        event,
        properties: [],
        property: null,
        visitors: 400,
        rows: [],
        rawOnly: true,
      }),
    });
    render(show());

    const properties = await screen.findByRole('region', { name: 'Properties of signup' });
    expect(
      await within(properties).findByText('signup carried no properties in this range.'),
    ).toBeInTheDocument();
    expect(
      within(properties).getByText("pa('event', 'signup', { plan: 'pro' });"),
    ).toBeInTheDocument();
  });
});

// A snippet somebody pastes has to run. An event name with a quote in it is a
// name a page can send, and a line that closes its own string on it is a line
// that throws.
describe('the line that sends an event', () => {
  it('escapes a quote and a backslash in the name', () => {
    expect(eventSnippet('signup')).toBe("pa('event', 'signup', { plan: 'pro' });");
    expect(eventSnippet("it's")).toBe("pa('event', 'it\\'s', { plan: 'pro' });");
    expect(eventSnippet('a\\b')).toBe("pa('event', 'a\\\\b', { plan: 'pro' });");
  });
});
