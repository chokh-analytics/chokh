import { focusManager, onlineManager } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Router } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditLogPage, AuditRow } from '../lib/api.js';
import { AuditLog } from './AuditLog.js';
import { NOW, ok, refused, serve, show, type Call } from './access.test-utils.js';

// The audit log's page. The case this file exists for is the one about when
// the log is asked for: opening it writes a row to it, so it is asked when
// somebody asks and at no other time.

const SITE_LOG = '/api/sites/s_test/audit';
const TEAM_LOG = '/api/teams/t_own/audit';

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    id: '1',
    siteId: 's_test',
    ts: NOW - 60_000,
    actor: { kind: 'session', id: 'u_me', email: 'owner@test.example' },
    action: 'read:identity',
    kind: 'identity',
    route: 'GET /api/sites/:siteId/visitors/:visitorId',
    target: 'v_ada',
    fields: ['ips', 'userId'],
    ...over,
  };
}

const ROWS: AuditRow[] = [
  row({ id: '4', action: 'read:audit', kind: 'log', route: 'GET /api/sites/:siteId/audit', fields: [] }),
  row({
    id: '3',
    action: 'member:set',
    kind: 'access',
    route: 'PUT /api/sites/:siteId/members/:userId',
    target: 'u_ada',
    fields: ['role: viewer > editor'],
  }),
  row({ id: '2', actor: { kind: 'key', id: 'k_backend' } }),
  row({ id: '1' }),
];

const ACCOUNTS: AuditLogPage['accounts'] = {
  u_me: { email: 'owner@test.example', name: 'Olu' },
  u_ada: { email: 'ada@test.example', name: 'Ada' },
};

function answer(page: Partial<AuditLogPage> = {}, identity = true): Response {
  return ok({ rows: ROWS, accounts: ACCOUNTS, next: null, ...page }, { identity, limit: 50 });
}

function asks(calls: Call[], path = SITE_LOG): Call[] {
  return calls.filter((call) => call.path === path);
}

function page(who?: Parameters<typeof show>[1]) {
  return render(<Router>{show(<AuditLog />, who)}</Router>);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/audit');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe('who the audit log is for', () => {
  it('tells somebody without admin who reads it, and asks the server nothing', async () => {
    const calls = serve(() => answer());
    page({ team: 'editor' });
    expect(screen.getByText(/Only an owner of this site, or of the team it belongs to, reads/)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls()).toEqual([]);
  });

  it("shows an owner of one site that site's log, and says whose the team's is without asking for it", async () => {
    const calls = serve(() => answer());
    page({ team: null, scopes: ['admin', 'read:identity', 'read:stats', 'write:events'] });
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('tab', { name: 'The team' }));
    expect(await screen.findByText('Only an owner of the team reads its log.')).toBeInTheDocument();
    expect(asks(calls(), TEAM_LOG)).toEqual([]);
  });

  it("reads the team's log for its owner", async () => {
    const calls = serve(() => answer({ rows: [row({ teamId: 't_own', action: 'invite:create', kind: 'access', target: 'grace@test.example' })] }));
    page();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('tab', { name: 'The team' }));
    expect(await screen.findByText('Sent an invitation')).toBeInTheDocument();
    expect(asks(calls(), TEAM_LOG)).toHaveLength(1);
    expect(window.location.search).toBe('?log=team');
  });
});

describe('the rows', () => {
  it('say who did what about whom, in words, with names where the page was given them', async () => {
    serve(() => answer());
    page();
    const table = await screen.findByRole('table', { name: 'The audit log, newest first.' });
    const lines = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((line) => within(line).getAllByRole('cell').map((cell) => cell.textContent));
    expect(lines.map((cells) => cells.slice(1, 4))).toEqual([
      ['Olu', 'Opened the audit log', 'v_ada'],
      ['Olu', 'Set a role', 'Ada'],
      ['Key k_backend', 'Read who a visitor is', 'v_ada'],
      ['Olu', 'Read who a visitor is', 'v_ada'],
    ]);
    // What changed, and the route that answered.
    expect(lines[1]?.[4]).toContain('role: viewer > editor');
    expect(lines[1]?.[4]).toContain('PUT /api/sites/:siteId/members/:userId');
    expect(screen.getByText('Showing all 4.')).toBeInTheDocument();
  });

  it('say that who each row is about is hidden, for a caller the server hid it from', async () => {
    serve(() =>
      answer(
        {
          rows: ROWS.map(({ target: _target, ...each }) => ({ ...each, actor: { kind: each.actor.kind, id: each.actor.id } })),
          accounts: {},
        },
        false,
      ),
    );
    page({ scopes: ['admin', 'read:stats'] });
    const table = await screen.findByRole('table');
    expect(screen.getByText(/Who each row is about is hidden/)).toBeInTheDocument();
    expect(within(table).getAllByText('Hidden')).toHaveLength(4);
    expect(within(table).getAllByText('Account u_me').length).toBeGreaterThan(0);
    // And the question that names a person is shut, with the reason.
    const about = screen.getByLabelText('About');
    expect(about).toBeDisabled();
    expect(screen.getByText('Asking about one person needs the read:identity permission.')).toBeInTheDocument();
  });

  it('say when there is nothing, and when the server refused', async () => {
    serve(() => answer({ rows: [], accounts: {} }));
    const first = page();
    expect(await screen.findByText('Nothing has been recorded here yet.')).toBeInTheDocument();
    first.unmount();

    vi.unstubAllGlobals();
    serve(() => refused(503, 'MIGRATION_REQUIRED', 'Run the migration first'));
    page();
    expect(await screen.findByRole('alert')).toHaveTextContent('Run the migration first');
  });
});

// Opening the log is a row in the log. A list that asked again whenever it
// could would write "the owner opened the log" every time a window was
// clicked on.
describe('when the log is asked for', () => {
  it('is once: not when the window gets the focus back, not when the network returns, not as time passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = serve(() => answer({ next: 'cursor-1' }));
    page();
    await screen.findByRole('table');
    expect(asks(calls())).toHaveLength(1);

    await act(async () => {
      // Away and back, the way a tab is left and returned to.
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      // Offline and on again.
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      // And two hours of the page being left open.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    });
    expect(asks(calls())).toHaveLength(1);
  });

  it('is again when somebody opens it again, and that is the only way', async () => {
    const calls = serve(() => answer());
    page();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Open the log again' }));
    await waitFor(() => expect(asks(calls())).toHaveLength(2));
    // A fresh opening: no cursor on either.
    expect(asks(calls()).map((call) => call.url.searchParams.get('cursor'))).toEqual([null, null]);
  });

  it('is not while a filter is being typed, only when Show is pressed', async () => {
    const calls = serve(() => answer());
    page();
    await screen.findByRole('table');
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'identity');
    await userEvent.type(screen.getByLabelText('About'), 'v_ada');
    await userEvent.type(screen.getByLabelText('By'), 'k_backend');
    await userEvent.type(screen.getByLabelText('From'), '2026-09-20');
    await userEvent.type(screen.getByLabelText('Up to'), '2026-09-22');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(asks(calls())).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(asks(calls())).toHaveLength(2));
    const asked = Object.fromEntries(asks(calls())[1]?.url.searchParams ?? []);
    expect(asked).toEqual({
      limit: '50',
      kind: 'identity',
      target: 'v_ada',
      actor: 'k_backend',
      // Whole days of the site's own calendar (Asia/Dhaka, six hours ahead),
      // the last one included.
      from: String(Date.UTC(2026, 8, 19, 18, 0, 0)),
      to: String(Date.UTC(2026, 8, 22, 18, 0, 0)),
    });
    // What was asked is in the address bar, so it can be sent to somebody.
    expect(window.location.search).toBe('?kind=identity&by=k_backend&about=v_ada&from=2026-09-20&to=2026-09-22');
  });

  it('refuses a range that ends before it starts without asking', async () => {
    const calls = serve(() => answer());
    page();
    await screen.findByRole('table');
    await userEvent.type(screen.getByLabelText('From'), '2026-09-22');
    await userEvent.type(screen.getByLabelText('Up to'), '2026-09-20');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('The first day has to come before the last.')).toBeInTheDocument();
    expect(asks(calls())).toHaveLength(1);
  });

  it('narrows to one person when their name is pressed in a row', async () => {
    const calls = serve(() => answer());
    page();
    await screen.findByRole('table');
    await userEvent.click(screen.getAllByRole('button', { name: 'Only rows about v_ada' })[0] as HTMLElement);
    await waitFor(() => expect(asks(calls())).toHaveLength(2));
    expect(asks(calls())[1]?.url.searchParams.get('target')).toBe('v_ada');
    expect(screen.getByLabelText('About')).toHaveValue('v_ada');

    await userEvent.click(screen.getAllByRole('button', { name: 'Only rows by Key k_backend' })[0] as HTMLElement);
    await waitFor(() => expect(asks(calls())).toHaveLength(3));
    expect(asks(calls())[2]?.url.searchParams.get('actor')).toBe('k_backend');
  });
});

describe('older rows', () => {
  it('are asked for with the cursor the page before gave, untouched', async () => {
    const calls = serve((call) =>
      call.url.searchParams.get('cursor') === null
        ? answer({ next: 'WzEsIjQiXQ.signed+by/the=server' })
        : answer({ rows: [row({ id: '0', target: 'v_older' })], next: null }),
    );
    page();
    await screen.findByRole('table');
    expect(screen.getByText('Showing the newest 4.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('v_older')).toBeInTheDocument();
    expect(asks(calls())[1]?.url.searchParams.get('cursor')).toBe('WzEsIjQiXQ.signed+by/the=server');
    expect(screen.getByText('Showing all 5.')).toBeInTheDocument();
  });

  it('say so when the listing is too old to carry on, keep what is on screen, and offer to open it again', async () => {
    let opened = 0;
    const calls = serve((call) => {
      if (call.url.searchParams.get('cursor') !== null) {
        return refused(400, 'CURSOR_EXPIRED', 'That listing was opened too long ago');
      }
      opened += 1;
      return answer({ next: 'an-old-cursor' });
    });
    page();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('opened more than an hour ago');
    // The rows already read are still there, and the dead button is not.
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Open the log again' }));
    await waitFor(() => expect(opened).toBe(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(asks(calls())).toHaveLength(3);
  });
});
