import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';
import { roundedNow } from '../app/useNow.js';
import { Realtime } from './Realtime.js';

// Who is here now, and the four things this page can get wrong.
//
// The two lists have to stay two lists: the second is the last half hour and is
// counted in none of the numbers above it, so a test that only counted rows
// would pass with the muted half folded into the online one. The address column
// has to follow the server's meta rather than the presence of a field, because
// an absent address and a withheld one look identical. And a page that says
// "Live" while it is polling says something untrue, so the two states are told
// apart here.

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
    timezone: 'Asia/Dhaka',
    allowUnsignedIdentify: false,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
  },
};

function visitor(over: Record<string, unknown> = {}) {
  return {
    visitorId: 'v_aaaaaaaaaa1',
    sessionId: 's_1',
    since: NOW - 300_000,
    lastSeenAt: NOW - 10_000,
    path: '/pricing',
    country: 'BD',
    city: 'Dhaka',
    browser: 'Chrome',
    os: 'Windows',
    device: 'desktop',
    lat: 23.81,
    lon: 90.41,
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    online: 1,
    signedIn: 0,
    anonymous: 1,
    byPage: [{ key: '/pricing', visitors: 1 }],
    byCountry: [{ key: 'BD', visitors: 1 }],
    byCity: [{ key: 'Dhaka', visitors: 1, country: 'BD', lat: 23.81, lon: 90.41 }],
    visitors: [visitor()],
    recent: [
      visitor({
        visitorId: 'v_bbbbbbbbbb2',
        sessionId: 's_2',
        path: '/docs',
        lastSeenAt: NOW - 400_000,
        city: 'Kolkata',
        country: 'IN',
        lat: 22.57,
        lon: 88.36,
      }),
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

interface Routes {
  realtime?: () => Response;
  timeseries?: () => Response;
}

function series(): unknown {
  const metrics = {
    visitors: 2,
    pageviews: 3,
    visits: 2,
    bounces: 0,
    bounceRate: 0,
    avgDurationMs: 1_000,
  };
  return {
    interval: 'minute',
    points: [
      { start: NOW - 120_000, end: NOW - 60_000, metrics },
      { start: NOW - 60_000, end: NOW, metrics: { ...metrics, pageviews: 4 } },
    ],
    previous: null,
  };
}

function serve(routes: Routes = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/stats/timeseries')) {
        return Promise.resolve((routes.timeseries ?? (() => ok(series())))());
      }
      return Promise.resolve((routes.realtime ?? (() => ok(snapshot())))());
    }),
  );
}

interface FakeStream {
  create: (url: string) => EventSource;
  open: () => void;
  frame: (data: unknown) => void;
  fail: () => void;
  // How many connections the hook has asked for. The give-up is a decision
  // meant to last the visit, and the only way to see it held is to count.
  connections: () => number;
}

// A stream a test drives by hand. EventSource is not in jsdom, so without this
// the live half of the page is never exercised at all.
function fakeStream(): FakeStream {
  const handlers: {
    onopen?: () => void;
    onmessage?: (event: MessageEvent<string>) => void;
    onerror?: () => void;
  } = {};
  const source = {
    set onopen(fn: () => void) {
      handlers.onopen = fn;
    },
    set onmessage(fn: (event: MessageEvent<string>) => void) {
      handlers.onmessage = fn;
    },
    set onerror(fn: () => void) {
      handlers.onerror = fn;
    },
    close: () => undefined,
  } as unknown as EventSource;
  let connections = 0;
  return {
    create: () => {
      connections += 1;
      return source;
    },
    open: () => handlers.onopen?.(),
    frame: (data: unknown) =>
      handlers.onmessage?.({
        data: JSON.stringify({ success: true, data }),
      } as MessageEvent<string>),
    fail: () => handlers.onerror?.(),
    connections: () => connections,
  };
}

// Leaving the tab, and coming back to it. document.hidden is read only in
// jsdom, so it is redefined rather than assigned, and the event is the one the
// browser fires.
async function hidden(away: boolean): Promise<void> {
  Object.defineProperty(document, 'hidden', { configurable: true, value: away });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function show(stream?: FakeStream, clock: number = NOW): JSX.Element {
  const client = createClient({ fetch: globalThis.fetch });
  const value: AppContextValue = {
    client,
    me: { actor: { kind: 'session', id: 'u_1' }, user: null, sites: [SITE], teams: [] },
    site: SITE,
    now: clock,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>
        <Realtime {...(stream === undefined ? {} : { stream: { create: stream.create } })} />
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function list(): HTMLElement {
  return screen.getByRole('table', { name: 'Everybody seen in the last half hour.' });
}

function tile(label: string): HTMLElement {
  const found = screen
    .getAllByText(label)
    .map((node) => node.closest('[class*="tile"]'))
    .find((node): node is HTMLElement => node !== null);
  if (found === undefined) {
    throw new Error(`No tile around ${label}`);
  }
  return found;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/realtime');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Realtime', () => {
  it('lists who is online, then the last half hour under its own heading', async () => {
    serve();
    render(show());

    await waitFor(() => expect(within(list()).getByText('/pricing')).toBeInTheDocument());
    const lines = within(list())
      .getAllByRole('row')
      .map((row) => row.textContent ?? '');
    const online = lines.findIndex((line) => line.includes('/pricing'));
    const divider = lines.findIndex((line) => line.includes('Seen in the last 30 minutes'));
    const earlier = lines.findIndex((line) => line.includes('/docs'));
    expect(online).toBeGreaterThan(0);
    expect(divider).toBeGreaterThan(online);
    expect(earlier).toBeGreaterThan(divider);
  });

  // The half hour is a courtesy, not a count: folding it into "online" would
  // say two people are on a site that one person is on.
  it('counts only the online list in the number above the lists', async () => {
    serve();
    render(show());

    await waitFor(() => expect(within(list()).getByText('/pricing')).toBeInTheDocument());
    expect(tile('Online now')).toHaveTextContent('1');
    expect(tile('Online now')).not.toHaveTextContent('2');
  });

  it('hides the address column without the permission, and says why', async () => {
    serve();
    render(show());

    await waitFor(() => expect(within(list()).getByText('/pricing')).toBeInTheDocument());
    expect(within(list()).queryByRole('columnheader', { name: 'Address' })).toBeNull();
    expect(
      screen.getByText('Addresses are hidden. They need the read:identity permission.'),
    ).toBeInTheDocument();
  });

  // The column follows the server's own statement and not a field that happens
  // to be there: a payload with no address and a payload with the address taken
  // out are the same payload.
  it('shows the address column when the meta says identity was allowed', async () => {
    serve({
      realtime: () =>
        ok(snapshot({ visitors: [visitor({ ip: '203.0.113.9', userId: 'u_7' })] }), {
          identity: true,
        }),
    });
    render(show());

    await waitFor(() =>
      expect(within(list()).getByRole('columnheader', { name: 'Address' })).toBeInTheDocument(),
    );
    expect(within(list()).getByText('203.0.113.9')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Addresses are shown because this account has read:identity. Each read is logged.',
      ),
    ).toBeInTheDocument();
  });

  // Nine seconds of "Live" with no frame in it is the most confident kind of
  // wrong a live page can be. A stream that is retrying says so, and the poll
  // behind it carries the page meanwhile.
  it('says it is reconnecting while the stream retries, and polls meanwhile', async () => {
    serve();
    const stream = fakeStream();
    render(show(stream));

    stream.open();
    stream.frame(snapshot());
    expect(await screen.findByText('Live')).toBeInTheDocument();

    stream.fail();
    expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();
    expect(screen.queryByText('Live')).toBeNull();
    // The interval is in the line, because a page that says it is reconnecting
    // and says nothing else looks stopped.
    expect(screen.getByText(/Updating every 5s/)).toBeInTheDocument();

    // A frame arriving is the connection coming back, and it also clears the
    // count: a drop every few minutes must not add up to a give-up.
    stream.frame(snapshot());
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it('says Live once the stream opens, and says polling when it gives up', async () => {
    serve();
    const stream = fakeStream();
    render(show(stream));

    stream.open();
    stream.frame(snapshot());
    expect(await screen.findByText('Live')).toBeInTheDocument();

    stream.fail();
    stream.fail();
    stream.fail();
    expect(await screen.findByText('Updating every 5s')).toBeInTheDocument();
    expect(screen.queryByText('Live')).toBeNull();
  });

  // The stream is closed behind a hidden tab and opened again on return, which
  // is right while it works and wrong once it has been given up on: coming back
  // to the tab used to restart a connection nobody had, and the pill went back
  // to claiming Live over a proxy that had already refused three times. The
  // give-up lasts the visit.
  it('does not reopen a stream it gave up on when the tab comes back', async () => {
    serve();
    const stream = fakeStream();
    render(show(stream));

    stream.open();
    stream.frame(snapshot());
    expect(await screen.findByText('Live')).toBeInTheDocument();

    stream.fail();
    stream.fail();
    stream.fail();
    expect(await screen.findByText('Updating every 5s')).toBeInTheDocument();
    expect(stream.connections()).toBe(1);

    await hidden(true);
    await hidden(false);

    expect(stream.connections()).toBe(1);
    expect(screen.getByText('Updating every 5s')).toBeInTheDocument();
    expect(screen.queryByText('Live')).toBeNull();
  });

  // The visitor list is the one place a duration is on screen, and the shell's
  // clock is rounded up to the next minute so a range never ends in the past.
  // Measured against that, a stay that began thirty seconds ago reads as a
  // minute and a half old.
  it('measures a stay against the wall clock and not the rounded one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Half past the minute, which is where the rounding is worst: the shell's
    // clock is already at the next minute, thirty seconds ahead of this.
    vi.setSystemTime(NOW + 30_000);
    serve({
      realtime: () =>
        ok(
          snapshot({
            visitors: [visitor({ since: NOW, lastSeenAt: NOW + 20_000 })],
            recent: [],
          }),
        ),
    });
    // What useNow hands the shell at this instant.
    render(show(undefined, roundedNow(NOW + 30_000)));

    await waitFor(() => expect(within(list()).getByText('/pricing')).toBeInTheDocument());
    // Thirty seconds by the clock on the wall. A minute by the rounded one.
    expect(within(list()).getByText('0m')).toBeInTheDocument();
    expect(within(list()).queryByText('1m')).toBeNull();
    vi.useRealTimers();
  });

  // Every other report narrows by putting a filter in the URL. This one has no
  // range and nothing to query: it picks those people out of the list that is
  // already on screen.
  it('narrows the visitor list to a page that was clicked, and back again', async () => {
    serve({
      realtime: () =>
        ok(
          snapshot({
            online: 2,
            anonymous: 2,
            byPage: [
              { key: '/pricing', visitors: 1 },
              { key: '/docs', visitors: 1 },
            ],
            visitors: [
              visitor({ path: '/pricing' }),
              visitor({ visitorId: 'v_other', path: '/docs' }),
            ],
            recent: [],
          }),
        ),
    });
    render(show());

    await waitFor(() => expect(within(list()).getByText('/pricing')).toBeInTheDocument());
    expect(within(list()).getByText('/docs')).toBeInTheDocument();

    const pages = screen.getByRole('region', { name: 'On these pages' });
    await userEvent.click(within(pages).getByRole('button', { name: /\/pricing/ }));

    expect(within(list()).getByText('/pricing')).toBeInTheDocument();
    expect(within(list()).queryByText('/docs')).toBeNull();
    // And nothing was put in the URL, because there is nothing to link to: a
    // snapshot of this second cannot be reproduced from one.
    expect(window.location.search).toBe('');

    await userEvent.click(screen.getByRole('button', { name: 'Show everybody' }));
    expect(within(list()).getByText('/docs')).toBeInTheDocument();
  });

  // "Online for 4m" under a heading that says the same thing is a number about
  // a visit that ended ten minutes ago.
  it('says when a muted row was last seen rather than how long it lasted', async () => {
    serve();
    render(show());

    await waitFor(() => expect(within(list()).getByText('/pricing')).toBeInTheDocument());
    expect(within(list()).getByText(/Last seen/)).toBeInTheDocument();
  });

  it('says nobody is here rather than drawing an empty table', async () => {
    serve({
      realtime: () =>
        ok(
          snapshot({
            online: 0,
            anonymous: 0,
            visitors: [],
            recent: [],
            byPage: [],
            byCountry: [],
            byCity: [],
          }),
        ),
    });
    render(show());

    expect(await screen.findByText('Nobody is on the site right now.')).toBeInTheDocument();
    expect(
      screen.queryByRole('table', { name: 'Everybody seen in the last half hour.' }),
    ).toBeNull();
  });

  // The two breakdowns beside the map empty on their own, while somebody is
  // still on the site: a visitor the geo database could not place, or a
  // pageview the exclusions dropped. This page has no range, so each card says
  // why it is empty in its own words rather than borrowing "No data in this
  // range" from a report that has one.
  it('says why each breakdown is empty rather than borrowing a range it has not got', async () => {
    serve({
      realtime: () => ok(snapshot({ byPage: [], byCountry: [], byCity: [] })),
    });
    render(show());

    // Somebody is here, so the list below is still a list.
    await waitFor(() => expect(within(list()).getByText('/pricing')).toBeInTheDocument());
    expect(screen.getByText('Nobody is on a page right now.')).toBeInTheDocument();
    expect(screen.getByText('Nobody is online right now.')).toBeInTheDocument();
    expect(screen.queryByText('Nobody is on the site right now.')).toBeNull();
    expect(screen.queryByText('No data in this range.')).toBeNull();
  });
});
