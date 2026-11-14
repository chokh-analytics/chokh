import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Router } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InvitationPreview, InvitationScope } from '../lib/api.js';
import { createClient } from '../lib/client.js';
import { forgetInviteToken } from '../lib/invite-token.js';
import { navigation } from '../lib/leave.js';
import { Invite } from './Invite.js';
import { NOW, ok, refused, serve, type Call } from './access.test-utils.js';

// The page an invitation link opens: where the token goes and where it never
// goes, and which of the three people it can be opened by gets which form.

const TOKEN = 'chi_an-invented-token-for-a-test-0123456789';
const PASSWORD = 'a-long-enough-password';

function preview(over: Partial<InvitationPreview> = {}): InvitationPreview {
  return {
    email: 'ada@test.example',
    scope: { kind: 'team', id: 't_own', name: 'Ours' },
    role: 'viewer',
    identity: false,
    invitedBy: 'Olu',
    expiresAt: NOW + 6 * 86_400_000,
    accountExists: false,
    ...over,
  };
}

interface World {
  preview?: InvitationPreview;
  lookup?: Response;
  // Who GET /api/me says is signed in, or null for nobody.
  me?: { id: string; email: string } | null;
  accept?: (call: Call) => Response;
  login?: (call: Call) => Response;
  // Whether the install signs people in through an identity provider.
  oidc?: boolean;
}

function world(given: World = {}): () => Call[] {
  let me = given.me ?? null;
  return serve((call) => {
    switch (`${call.method} ${call.path}`) {
      case 'POST /api/invitations/lookup':
        return given.lookup ?? ok({ invitation: given.preview ?? preview() });
      case 'GET /api/me':
        return me === null
          ? refused(401, 'UNAUTHENTICATED', 'Sign in first')
          : ok({ actor: { kind: 'session', id: me.id }, user: me, sites: [], teams: [] });
      case 'POST /api/invitations/accept':
        return (
          given.accept?.(call) ??
          ok({
            user: { id: 'u_ada', email: 'ada@test.example' },
            created: true,
            scope: { kind: 'team', id: 't_own' },
            role: 'viewer',
          })
        );
      case 'POST /api/auth/login':
        return given.login?.(call) ?? ok({ user: { id: 'u_ada', email: 'ada@test.example' } });
      case 'GET /api/ee/oidc':
        return given.oidc === undefined ? undefined : ok({ enabled: given.oidc });
      case 'POST /api/ee/oidc/invite':
        return ok({ url: 'https://provider.example/authorize?state=abc' });
      case 'POST /api/auth/logout':
        me = null;
        return ok({ signedOut: true });
      default:
        return undefined;
    }
  });
}

function open(accepted: InvitationScope[] = []): InvitationScope[] {
  render(
    <Router>
      <Invite
        client={createClient({ fetch: globalThis.fetch })}
        onAccepted={(scope) => accepted.push(scope)}
      />
    </Router>,
  );
  return accepted;
}

function withToken(): void {
  // As the browser arrives: the token in the fragment. The module takes it
  // off when the page asks for it.
  window.history.replaceState(null, '', `/invite#${TOKEN}`);
}

// Everywhere a token must never be: any request's address, the page's own
// address, either storage area.
function expectTokenKeptOut(calls: Call[]): void {
  for (const call of calls) {
    expect(call.url.href).not.toContain(TOKEN);
  }
  expect(window.location.href).not.toContain(TOKEN);
  expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(TOKEN);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  forgetInviteToken();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the invitation page', () => {
  it('opened without a link says what it is for and asks the server nothing', async () => {
    window.history.replaceState(null, '', '/invite');
    const calls = world();
    open();
    expect(screen.getByText(/This page opens from an invitation link/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls()).toEqual([]);
  });

  it('takes the token out of the address bar and sends it in a body, never in an address', async () => {
    withToken();
    const calls = world();
    open();
    expect(window.location.hash).toBe('');
    expect(await screen.findByText('Olu invited ada@test.example to the team Ours, as Viewer.')).toBeInTheDocument();
    const lookup = calls().find((call) => call.path === '/api/invitations/lookup');
    expect(lookup?.method).toBe('POST');
    expect(lookup?.body).toEqual({ token: TOKEN });
    expectTokenKeptOut(calls());
    // It is not in the page either: nothing draws it.
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('starts over when the link is opened again in the same tab, and takes that token off too', async () => {
    window.history.replaceState(null, '', '/invite');
    const calls = world();
    open();
    expect(screen.getByText(/This page opens from an invitation link/)).toBeInTheDocument();

    window.history.replaceState(null, '', `/invite#${TOKEN}`);
    window.dispatchEvent(new Event('hashchange'));
    expect(await screen.findByText('Olu invited ada@test.example to the team Ours, as Viewer.')).toBeInTheDocument();
    expect(calls().find((call) => call.path === '/api/invitations/lookup')?.body).toEqual({ token: TOKEN });
    expectTokenKeptOut(calls());
  });

  it('says what a refused link is, in the words the server used, and offers no form', async () => {
    withToken();
    world({ lookup: refused(410, 'INVITATION_EXPIRED', 'That invitation has expired') });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('That invitation has expired');
    expect(screen.getByText('Ask whoever invited you for a new link.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('an address that has no account yet', () => {
  it('chooses a password, and the account is made and let in by one request', async () => {
    withToken();
    const calls = world({ preview: preview({ identity: true, scope: { kind: 'site', id: 's_test', name: 'Progsity' } }),
      accept: () =>
        ok({ user: { id: 'u_ada', email: 'ada@test.example' }, created: true, scope: { kind: 'site', id: 's_test' }, role: 'viewer' }),
    });
    const accepted = open();
    expect(await screen.findByText('Olu invited ada@test.example to the site Progsity, as Viewer.')).toBeInTheDocument();
    expect(screen.getByText('You will also be able to see who its visitors are.')).toBeInTheDocument();
    // The address is the invitation's and is not theirs to change.
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Email')).toHaveValue('ada@test.example');

    await userEvent.type(screen.getByLabelText('Your name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Choose a password'), PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Make the account and accept' }));

    await waitFor(() => expect(accepted).toEqual([{ kind: 'site', id: 's_test' }]));
    const sent = calls().find((call) => call.path === '/api/invitations/accept');
    expect(sent?.body).toEqual({ token: TOKEN, password: PASSWORD, name: 'Ada' });
    expect(calls().some((call) => call.path === '/api/auth/login')).toBe(false);
    expectTokenKeptOut(calls());
    expect(screen.getByRole('status')).toHaveTextContent('You are in.');
  });

  it('is told a password is too short before anything is sent', async () => {
    withToken();
    const calls = world();
    open();
    await userEvent.type(await screen.findByLabelText('Choose a password'), 'too-short');
    await userEvent.click(screen.getByRole('button', { name: 'Make the account and accept' }));
    expect(await screen.findByText('A password is at least 12 characters.')).toBeInTheDocument();
    expect(calls().some((call) => call.path === '/api/invitations/accept')).toBe(false);
  });

  it('keeps the link usable after a refusal, and says what the server said', async () => {
    withToken();
    let tries = 0;
    const calls = world({
      accept: () => {
        tries += 1;
        return tries === 1
          ? refused(429, 'RATE_LIMITED', 'Too many attempts from this address, wait a minute')
          : ok({ user: { id: 'u_ada', email: 'ada@test.example' }, created: true, scope: { kind: 'team', id: 't_own' }, role: 'viewer' });
      },
    });
    const accepted = open();
    await userEvent.type(await screen.findByLabelText('Choose a password'), PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Make the account and accept' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
    await userEvent.click(screen.getByRole('button', { name: 'Make the account and accept' }));
    await waitFor(() => expect(accepted).toHaveLength(1));
    expect(calls().filter((call) => call.path === '/api/invitations/accept')).toHaveLength(2);
  });
});

describe('an address that already has an account', () => {
  it('signs in on this page, as that address, and then accepts with no password in the acceptance', async () => {
    withToken();
    const calls = world({
      preview: preview({ accountExists: true }),
      accept: () =>
        ok({ user: { id: 'u_ada', email: 'ada@test.example' }, created: false, scope: { kind: 'team', id: 't_own' }, role: 'viewer' }),
    });
    const accepted = open();
    expect(await screen.findByText(/An account with this address already exists/)).toBeInTheDocument();
    // No link away to /login: the token would not survive the trip.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByLabelText('Choose a password')).toBeNull();

    await userEvent.type(screen.getByLabelText('Password'), PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in and accept' }));
    await waitFor(() => expect(accepted).toHaveLength(1));

    const order = calls()
      .filter((call) => call.method === 'POST')
      .map((call) => call.path);
    expect(order).toEqual(['/api/invitations/lookup', '/api/auth/login', '/api/invitations/accept']);
    expect(calls().find((call) => call.path === '/api/auth/login')?.body).toEqual({
      email: 'ada@test.example',
      password: PASSWORD,
    });
    expect(calls().find((call) => call.path === '/api/invitations/accept')?.body).toEqual({ token: TOKEN });
    expectTokenKeptOut(calls());
  });

  it('is not accepted when the sign-in is refused, and nothing was spent', async () => {
    withToken();
    const calls = world({
      preview: preview({ accountExists: true }),
      login: () => refused(401, 'INVALID_CREDENTIALS', 'That address and password do not match'),
    });
    const accepted = open();
    await userEvent.type(await screen.findByLabelText('Password'), 'not-the-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in and accept' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(calls().some((call) => call.path === '/api/invitations/accept')).toBe(false);
    expect(accepted).toEqual([]);
  });

  it('accepts with one press when that account is already signed in', async () => {
    withToken();
    const calls = world({
      preview: preview({ accountExists: true }),
      me: { id: 'u_ada', email: 'Ada@Test.Example' },
    });
    const accepted = open();
    expect(await screen.findByText('You are signed in as Ada@Test.Example.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Accept the invitation' }));
    await waitFor(() => expect(accepted).toHaveLength(1));
    expect(calls().find((call) => call.path === '/api/invitations/accept')?.body).toEqual({ token: TOKEN });
  });
});

describe('somebody signed in as another account', () => {
  it('is told which account is here and which the invitation is for, and can sign out to use it', async () => {
    withToken();
    const calls = world({ me: { id: 'u_olu', email: 'olu@test.example' } });
    open();
    expect(
      await screen.findByText(
        'This invitation is for ada@test.example, and you are signed in as olu@test.example. Sign out to use it.',
      ),
    ).toBeInTheDocument();
    // Neither form: the server would refuse both from inside this session.
    expect(screen.queryByLabelText('Choose a password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept the invitation' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Choose a password')).toBeInTheDocument();
    expect(calls().some((call) => call.path === '/api/auth/logout')).toBe(true);
    // The link is still in hand after signing out.
    expect(calls().filter((call) => call.path === '/api/invitations/lookup')).toHaveLength(1);
  });
});

describe('single sign-on on the invitation page', () => {
  it('is not offered where the install does not have it', async () => {
    withToken();
    world();
    open();
    await screen.findByLabelText('Choose a password');
    expect(screen.queryByRole('button', { name: 'Use single sign-on instead' })).toBeNull();
  });

  it('sends the token in a body, forgets it, and leaves for where the server says', async () => {
    withToken();
    const calls = world({ oidc: true });
    const left: string[] = [];
    vi.spyOn(navigation, 'leave').mockImplementation((url) => void left.push(url));
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Use single sign-on instead' }));
    await waitFor(() => expect(left).toEqual(['https://provider.example/authorize?state=abc']));
    const sent = calls().find((call) => call.path === '/api/ee/oidc/invite');
    expect(sent).toMatchObject({ method: 'POST', body: { token: TOKEN } });
    expectTokenKeptOut(calls());
    // Nothing was accepted here: the provider's answer decides that.
    expect(calls().some((call) => call.path === '/api/invitations/accept')).toBe(false);
  });

  it('is not offered to an address that already has an account, which signs in to it first', async () => {
    withToken();
    world({ oidc: true, preview: preview({ accountExists: true }) });
    open();
    await screen.findByLabelText('Password');
    expect(screen.queryByRole('button', { name: 'Use single sign-on instead' })).toBeNull();
  });
});
