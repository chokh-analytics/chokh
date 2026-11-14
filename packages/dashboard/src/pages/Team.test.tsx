import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invitation, ListedMember } from '../lib/api.js';
import { navigation } from '../lib/leave.js';
import { NOW, ok, refused, serve, show, type Call } from './access.test-utils.js';
import { Team } from './Team.js';

// The Team page: what it asks the server for whom, the link that is shown
// once, and the two things a change can come back with, which the page puts
// in front of the owner and never decides for them.

const TOKEN = 'chi_an-invented-token-for-a-test-0123456789';

const ADA: ListedMember = {
  userId: 'u_ada',
  email: 'ada@test.example',
  name: 'Ada',
  role: 'editor',
  identity: false,
  managed: false,
};
const ME: ListedMember = {
  userId: 'u_me',
  email: 'owner@test.example',
  role: 'owner',
  identity: true,
  managed: false,
};
const STAFF: ListedMember = {
  userId: 'sso_staff_5',
  email: 'staff@elsewhere.example',
  role: 'viewer',
  identity: false,
  managed: true,
};

function invitation(over: Partial<Invitation> = {}): Invitation {
  return {
    id: 'inv_1',
    email: 'grace@test.example',
    scope: { kind: 'team', id: 't_own' },
    role: 'viewer',
    identity: false,
    invitedBy: 'u_me',
    createdAt: NOW - 60_000,
    expiresAt: NOW + 6 * 86_400_000,
    state: 'pending',
    usable: true,
    ...over,
  };
}

interface World {
  team?: ListedMember[];
  site?: ListedMember[];
  teamInvitations?: Invitation[];
  siteInvitations?: Invitation[];
  // What this install may run. No key unless a case says otherwise.
  features?: string[];
  // Single sign-on: off unless a case says what the account's state is.
  identity?: { connected: boolean; canDisconnect: boolean };
  // Anything that is not one of the reads.
  write?: (call: Call) => Response | undefined;
}

function world(given: World = {}): () => Call[] {
  return serve((call) => {
    if (call.method === 'GET') {
      switch (call.path) {
        case '/api/teams/t_own/members':
          return ok({ team: { id: 't_own', name: 'Ours' }, members: given.team ?? [ME, ADA] });
        case '/api/sites/s_test/members':
          return ok({ members: given.site ?? [] });
        case '/api/teams/t_own/invitations':
          return ok({ invitations: given.teamInvitations ?? [] });
        case '/api/sites/s_test/invitations':
          return ok({ invitations: given.siteInvitations ?? [] });
        case '/api/ee/oidc':
          return ok({ enabled: given.identity !== undefined });
        case '/api/ee/oidc/identity':
          return given.identity === undefined
            ? refused(403, 'LICENSE_REQUIRED')
            : ok({ enabled: true, ...given.identity });
        case '/api/license':
          return ok({
            licensed: given.features !== undefined,
            plan: given.features === undefined ? null : 'pro',
            licensee: given.features === undefined ? null : 'A Test Company Ltd.',
            expiresAt: null,
            features: given.features ?? [],
          });
        default:
          return undefined;
      }
    }
    return given.write?.(call);
  });
}

function card(name: string | RegExp): HTMLElement {
  return screen.getByRole('region', { name });
}

function writes(calls: Call[]): Call[] {
  return calls.filter((call) => call.method !== 'GET');
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s_test/team');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('who the Team page is for', () => {
  it('tells somebody without admin who sees it, and asks the server nothing about who is here', async () => {
    const calls = world();
    render(show(<Team />, { team: 'viewer' }));
    expect(screen.getByText(/Only an owner of this site, or of the team it belongs to/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Invite somebody' })).toBeNull();
    // The way to the other two pages is still there.
    expect(screen.getByRole('navigation', { name: 'About this site' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The one thing asked is whether the install has single sign-on, which
    // is open to anybody and is about their own account.
    expect(calls().map((call) => call.path)).toEqual(['/api/ee/oidc']);
  });

  it('gives an owner of one site that site, and not the team', async () => {
    const calls = world({ site: [{ ...ADA, role: 'viewer' }] });
    render(show(<Team />, { team: null, scopes: ['admin', 'read:identity', 'read:stats', 'write:events'] }));
    expect(await within(card('On this site only')).findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Only an owner of the team sees and changes who is in it.')).toBeInTheDocument();
    // They can invite to the site they run, and to nothing else.
    const to = within(card('Invite somebody')).getByLabelText('To');
    expect(within(to).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'This site only, Progsity',
    ]);
    expect(calls().map((call) => call.path).sort()).toEqual([
      '/api/ee/oidc',
      '/api/license',
      '/api/sites/s_test/invitations',
      '/api/sites/s_test/members',
    ]);
  });
});

describe('an invitation', () => {
  function made(call: Call): Response {
    const body = call.body as { email: string; role: Invitation['role']; identity: boolean };
    return ok({
      invitation: invitation({ email: body.email, role: body.role, identity: body.identity }),
      once: { token: TOKEN, link: `/invite#${TOKEN}` },
    });
  }

  it('is made for the whole team, and its link is shown once with a way to copy it', async () => {
    const calls = world({ write: (call) => (call.method === 'POST' ? made(call) : undefined) });
    const copied: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
    });
    render(show(<Team />));
    const form = card('Invite somebody');
    await userEvent.type(within(form).getByLabelText('Their email'), 'grace@test.example');
    await userEvent.click(within(form).getByRole('button', { name: 'Make the link' }));

    const panel = await screen.findByRole('group', { name: 'The link for grace@test.example' });
    expect(writes(calls())).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/api/teams/t_own/invitations',
        body: { email: 'grace@test.example', role: 'viewer', identity: false },
      }),
    ]);
    // The whole link, on this dashboard's own origin, and the sentence.
    const link = `${window.location.origin}/invite#${TOKEN}`;
    expect(within(panel).getByLabelText('The invitation link')).toHaveValue(link);
    expect(within(panel).getByText(/shown once and will not be shown again/)).toBeInTheDocument();
    // The question that was just answered has the focus.
    expect(panel).toHaveFocus();

    await userEvent.click(within(panel).getByRole('button', { name: 'Copy the link' }));
    expect(copied).toEqual([link]);
    expect(within(panel).getByRole('status')).toHaveTextContent('Copied.');

    // Dismissed, it is gone from the page, and it was never written anywhere.
    await userEvent.click(within(panel).getByRole('button', { name: 'I have sent it' }));
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(TOKEN);
  });

  it('is made for this site alone when that is chosen, and an owner always sees who visitors are', async () => {
    const calls = world({ write: (call) => (call.method === 'POST' ? made(call) : undefined) });
    render(show(<Team />));
    const form = card('Invite somebody');
    await userEvent.type(within(form).getByLabelText('Their email'), 'grace@test.example');
    await userEvent.selectOptions(within(form).getByLabelText('To'), 'site');
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'owner');
    const sees = within(form).getByRole('checkbox', { name: 'May see who visitors are' });
    expect(sees).toBeChecked();
    expect(sees).toBeDisabled();
    await userEvent.click(within(form).getByRole('button', { name: 'Make the link' }));
    await waitFor(() =>
      expect(writes(calls())).toEqual([
        expect.objectContaining({
          path: '/api/sites/s_test/invitations',
          body: { email: 'grace@test.example', role: 'owner', identity: true },
        }),
      ]),
    );
  });

  it('is not sent without an address, and says why the server refused one', async () => {
    const calls = world({
      write: () => refused(409, 'ALREADY_MEMBER', 'That person already has a role here'),
    });
    render(show(<Team />));
    const form = card('Invite somebody');
    await userEvent.click(within(form).getByRole('button', { name: 'Make the link' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('An email address is needed.');
    expect(writes(calls())).toEqual([]);

    await userEvent.type(within(form).getByLabelText('Their email'), 'ada@test.example');
    await userEvent.click(within(form).getByRole('button', { name: 'Make the link' }));
    expect(await within(form).findByText('That person already has a role here')).toBeInTheDocument();
  });

  it('waiting says whether its link would work, and is taken back after a second press', async () => {
    const calls = world({
      teamInvitations: [
        invitation(),
        invitation({ id: 'inv_2', email: 'lost@test.example', usable: false }),
      ],
      siteInvitations: [
        invitation({
          id: 'inv_3',
          email: 'late@test.example',
          scope: { kind: 'site', id: 's_test' },
          state: 'expired',
          usable: false,
          expiresAt: NOW - 86_400_000,
        }),
      ],
      write: (call) => (call.method === 'DELETE' ? ok({ invitation: invitation() }) : undefined),
    });
    render(show(<Team />));
    const list = await within(card('Invitations waiting')).findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const text = (email: string) => rows.find((row) => within(row).queryByText(email) !== null)?.textContent ?? '';
    expect(text('grace@test.example')).toMatch(/Viewer, the whole team.*Waiting\. The link works until/);
    expect(text('lost@test.example')).toContain('Waiting, but the link will not work');
    expect(text('late@test.example')).toMatch(/Viewer, this site only.*Expired on/);
    // No list ever carries a link or a token.
    expect(list.innerHTML).not.toContain('/invite');

    await userEvent.click(
      within(list).getByRole('button', { name: 'Take back the invitation to grace@test.example' }),
    );
    expect(writes(calls())).toEqual([]);
    await userEvent.click(within(list).getByRole('button', { name: 'Take it back' }));
    await waitFor(() =>
      expect(writes(calls())).toEqual([
        expect.objectContaining({ method: 'DELETE', path: '/api/teams/t_own/invitations/inv_1' }),
      ]),
    );
  });
});

describe('a change to somebody in the team', () => {
  const KEY = { id: 'k_1', name: 'collector', siteId: 's_other', scopes: ['write:events'] };

  function row(name: string): HTMLElement {
    const list = within(card('The team, Ours')).getByRole('list');
    const found = within(list)
      .getAllByRole('listitem')
      .find((item) => within(item).queryByText(name) !== null);
    if (found === undefined) throw new Error(`no row for ${name}`);
    return found;
  }

  it('sends the role and the flag, and says when it ended their sessions', async () => {
    const calls = world({
      write: () =>
        ok({ team: {} }, { sessionsEnded: true, siteRolesKept: [], keysRevoked: [], keysKept: [], invitationsRevoked: 0 }),
    });
    render(show(<Team />));
    await screen.findByText('Ada');
    const ada = row('Ada');
    // Nothing to save until something is different.
    expect(within(ada).getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.selectOptions(within(ada).getByLabelText('Role of Ada'), 'viewer');
    await userEvent.click(within(ada).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(writes(calls())).toEqual([
        expect.objectContaining({
          method: 'PUT',
          path: '/api/teams/t_own/members/u_ada',
          body: { role: 'viewer', identity: false },
        }),
      ]),
    );
    expect(await within(card('The team, Ours')).findByRole('status')).toHaveTextContent(
      'Their sessions were ended',
    );
  });

  it('asks about the keys they made instead of deciding, and goes on with the answer', async () => {
    const calls = world({
      write: (call) =>
        (call.body as { revokeKeys?: boolean }).revokeKeys === undefined
          ? refused(409, 'KEYS_DECISION_REQUIRED', 'Say whether to revoke them', { keys: [KEY] })
          : ok({ team: {} }, { sessionsEnded: true, siteRolesKept: [] }),
    });
    render(show(<Team />));
    await screen.findByText('Ada');
    await userEvent.selectOptions(within(row('Ada')).getByLabelText('Role of Ada'), 'viewer');
    await userEvent.click(within(row('Ada')).getByRole('button', { name: 'Save' }));

    const question = await screen.findByRole('group', { name: 'Keys made by Ada' });
    expect(question).toHaveFocus();
    // The key by its name, the site by its name, and what it can do.
    expect(within(question).getByText('collector, on Blog, with write:events')).toBeInTheDocument();
    expect(writes(calls())).toHaveLength(1);

    await userEvent.click(within(question).getByRole('button', { name: 'Keep them and go on' }));
    await waitFor(() => expect(writes(calls())).toHaveLength(2));
    expect(writes(calls())[1]?.body).toEqual({ role: 'viewer', identity: false, revokeKeys: false });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Keys made by Ada' })).toBeNull());
  });

  it('changes nothing when the keys question is turned down', async () => {
    const calls = world({
      write: () => refused(409, 'KEYS_DECISION_REQUIRED', 'Say whether to revoke them', { keys: [KEY] }),
    });
    render(show(<Team />));
    await screen.findByText('Ada');
    await userEvent.click(within(row('Ada')).getByRole('button', { name: 'Remove Ada' }));
    await userEvent.click(within(row('Ada')).getByRole('button', { name: 'Remove' }));
    const question = await screen.findByRole('group', { name: 'Keys made by Ada' });
    await userEvent.click(within(question).getByRole('button', { name: 'Change nothing' }));
    expect(screen.queryByRole('group', { name: 'Keys made by Ada' })).toBeNull();
    expect(writes(calls())).toHaveLength(1);
  });

  it('says what the person still holds on single sites, and takes those off only when asked', async () => {
    const kept = [
      { siteId: 's_test', role: 'viewer', identity: true },
      { siteId: 's_other', role: 'owner', identity: true },
    ];
    let asked = 0;
    const calls = world({
      write: (call) => {
        if (call.path === '/api/teams/t_own/members/u_ada') {
          return ok({ team: {} }, { sessionsEnded: true, siteRolesKept: kept });
        }
        // The second site asks about a key the first time it is asked.
        if (call.path === '/api/sites/s_other/members/u_ada' && !call.url.searchParams.has('revokeKeys')) {
          asked += 1;
          return refused(409, 'KEYS_DECISION_REQUIRED', 'Say whether to revoke them', { keys: [KEY] });
        }
        return ok({ members: [] }, { sessionsEnded: true, siteRolesKept: [] });
      },
    });
    render(show(<Team />));
    await screen.findByText('Ada');
    await userEvent.click(within(row('Ada')).getByRole('button', { name: 'Remove Ada' }));
    await userEvent.click(within(row('Ada')).getByRole('button', { name: 'Remove' }));

    const still = await screen.findByRole('group', { name: 'Ada still holds a role on single sites' });
    expect(within(still).getByText('Viewer on Progsity')).toBeInTheDocument();
    expect(within(still).getByText('Owner on Blog')).toBeInTheDocument();
    // Nothing was taken off by itself.
    expect(writes(calls()).map((call) => call.path)).toEqual(['/api/teams/t_own/members/u_ada']);

    await userEvent.click(within(still).getByRole('button', { name: 'Take these off too' }));
    const question = await screen.findByRole('group', { name: 'Keys made by Ada' });
    await userEvent.click(within(question).getByRole('button', { name: 'Revoke them and go on' }));
    await waitFor(() => expect(screen.getByText('Those were taken off as well.')).toBeInTheDocument());
    // Each row once: the one that went through before the question is not
    // sent again when the question is answered.
    expect(
      writes(calls()).map((call) => `${call.method} ${call.path}${call.url.search}`),
    ).toEqual([
      'DELETE /api/teams/t_own/members/u_ada',
      'DELETE /api/sites/s_test/members/u_ada',
      'DELETE /api/sites/s_other/members/u_ada',
      'DELETE /api/sites/s_other/members/u_ada?revokeKeys=true',
    ]);
    expect(asked).toBe(1);
  });

  it('leaves the roles standing when that is the answer', async () => {
    const calls = world({
      write: () =>
        ok({ team: {} }, { sessionsEnded: true, siteRolesKept: [{ siteId: 's_test', role: 'viewer', identity: false }] }),
    });
    render(show(<Team />));
    await screen.findByText('Ada');
    await userEvent.click(within(row('Ada')).getByRole('button', { name: 'Remove Ada' }));
    await userEvent.click(within(row('Ada')).getByRole('button', { name: 'Remove' }));
    const still = await screen.findByRole('group', { name: 'Ada still holds a role on single sites' });
    await userEvent.click(within(still).getByRole('button', { name: 'Leave them' }));
    expect(screen.queryByRole('group', { name: 'Ada still holds a role on single sites' })).toBeNull();
    expect(writes(calls())).toHaveLength(1);
  });

  it('shows the server refusing to leave the team without an owner', async () => {
    world({
      team: [ME],
      write: () => refused(409, 'LAST_OWNER', 'A team keeps at least one owner'),
    });
    render(show(<Team />));
    const me = await screen.findByText('You');
    const item = me.closest('li') as HTMLElement;
    await userEvent.selectOptions(within(item).getByLabelText(/^Role of/), 'viewer');
    await userEvent.click(within(item).getByRole('button', { name: 'Save' }));
    expect(await within(card('The team, Ours')).findByRole('alert')).toHaveTextContent(
      'A team keeps at least one owner',
    );
  });

  it('does not edit somebody another application signs in, and can still remove them', async () => {
    const calls = world({
      team: [ME, STAFF],
      write: () => ok({ team: {} }, { sessionsEnded: true, siteRolesKept: [] }),
    });
    render(show(<Team />));
    await screen.findByText('staff@elsewhere.example');
    const staff = row('staff@elsewhere.example');
    expect(within(staff).queryByRole('combobox')).toBeNull();
    expect(within(staff).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(staff).getByText(/Signed in by another application/)).toBeInTheDocument();
    await userEvent.click(
      within(staff).getByRole('button', { name: 'Remove staff@elsewhere.example' }),
    );
    await userEvent.click(within(staff).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(writes(calls()).map((call) => `${call.method} ${call.path}`)).toEqual([
        'DELETE /api/teams/t_own/members/sso_staff_5',
      ]),
    );
  });
});

describe('a role on this site only', () => {
  it('is changed and removed through the site, and an empty list says so', async () => {
    const calls = world({
      site: [{ ...ADA, role: 'viewer' }],
      write: () => ok({ members: [] }, { sessionsEnded: false, siteRolesKept: [] }),
    });
    const view = render(show(<Team />));
    const site = card('On this site only');
    await within(site).findByText('Ada');
    await userEvent.click(within(site).getByRole('checkbox', { name: 'Ada may see who visitors are' }));
    await userEvent.click(within(site).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(writes(calls())).toEqual([
        expect.objectContaining({
          method: 'PUT',
          path: '/api/sites/s_test/members/u_ada',
          body: { role: 'viewer', identity: true },
        }),
      ]),
    );
    view.unmount();

    vi.unstubAllGlobals();
    world();
    render(show(<Team />));
    expect(await screen.findByText('Nobody holds a role on this site alone.')).toBeInTheDocument();
  });
});

// More than one team is part of Chokh Pro. AGENTS.md rule 10: on an install
// with no key the card is there, named and described, with nothing in it to
// fill in; with a key it is three controls.
describe('more than one team', () => {
  const TEAMS = [
    { id: 't_own', name: 'Ours', role: 'owner' as const },
    { id: 't_empty', name: 'Empty', role: 'owner' as const },
    { id: 'default', name: 'First', role: 'owner' as const },
    { id: 't_theirs', name: 'Theirs', role: 'viewer' as const },
  ];

  function paid(calls: Call[]): Call[] {
    return calls.filter(
      (call) => call.path.startsWith('/api/ee/teams') || call.path.startsWith('/api/ee/sites'),
    );
  }

  it('is named and described on an install with no key, with nothing in it to fill in', async () => {
    const calls = world();
    render(show(<Team />, { teams: TEAMS }));
    const teams = card('More than one team');
    expect(within(teams).getByText('Part of Chokh Pro')).toBeInTheDocument();
    expect(
      within(teams).getByText('More than one team is part of Chokh Pro. It is here, and a licence key turns it on.'),
    ).toBeInTheDocument();
    // The teams that exist are listed all the same: they work without a key.
    const list = within(teams).getByRole('list', { name: 'The teams you are in' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'OursOwner, 2 sites',
      'EmptyOwner, no sites',
      'FirstOwner, no sites',
      'TheirsViewer, no sites',
    ]);
    await screen.findByText('Ada');
    for (const role of ['button', 'textbox', 'combobox'] as const) {
      expect(within(teams).queryByRole(role)).toBeNull();
    }
    expect(paid(calls())).toEqual([]);
  });

  it('makes a team with a key, and says who owns it', async () => {
    const calls = world({
      features: ['*'],
      write: (call) =>
        call.path === '/api/ee/teams'
          ? ok({ team: { id: 't_new', name: (call.body as { name: string }).name, role: 'owner' } })
          : undefined,
    });
    render(show(<Team />, { teams: TEAMS }));
    const teams = card('More than one team');
    const name = await within(teams).findByLabelText('Its name');
    // Nothing is sent without a name.
    await userEvent.click(within(teams).getByRole('button', { name: 'Make the team' }));
    expect(await within(teams).findByText('A name is needed.')).toBeInTheDocument();
    expect(paid(calls())).toEqual([]);

    await userEvent.type(name, 'Clients');
    await userEvent.click(within(teams).getByRole('button', { name: 'Make the team' }));
    expect(await within(teams).findByRole('status')).toHaveTextContent(
      'Clients is made, and you own it. It holds no site yet.',
    );
    expect(paid(calls())).toEqual([
      expect.objectContaining({ method: 'POST', path: '/api/ee/teams', body: { name: 'Clients' } }),
    ]);
  });

  it('deletes an empty team an owner asks twice for, and says why the others stay', async () => {
    const calls = world({
      features: ['teams'],
      write: (call) => (call.method === 'DELETE' ? ok({ deleted: true }) : undefined),
    });
    render(show(<Team />, { teams: TEAMS }));
    const teams = card('More than one team');
    const remove = (team: string) => within(teams).findByRole('button', { name: `Delete the team ${team}` });
    expect(await remove('Ours')).toBeDisabled();
    expect(within(teams).getByText('A team that holds a site is not deleted. Move its sites first.')).toBeInTheDocument();
    expect(await remove('First')).toBeDisabled();
    expect(within(teams).getByText('The first team is never deleted.')).toBeInTheDocument();
    expect(await remove('Theirs')).toBeDisabled();
    expect(within(teams).getByText('Only an owner deletes a team.')).toBeInTheDocument();

    await userEvent.click(await remove('Empty'));
    expect(paid(calls())).toEqual([]);
    expect(within(teams).getByText('Delete Empty? The invitations waiting on it go with it.')).toBeInTheDocument();
    await userEvent.click(within(teams).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(paid(calls()).map((call) => `${call.method} ${call.path}`)).toEqual([
        'DELETE /api/ee/teams/t_empty',
      ]),
    );
    expect(await within(teams).findByRole('status')).toHaveTextContent('Empty is deleted.');
  });

  it('moves the site to another team its owner owns, asking about keys when the server does', async () => {
    const key = { id: 'k_1', name: 'collector', siteId: 's_test', scopes: ['write:events'] };
    const calls = world({
      features: ['*'],
      write: (call) =>
        (call.body as { revokeKeys?: boolean }).revokeKeys === undefined
          ? refused(409, 'KEYS_DECISION_REQUIRED', 'Say whether to revoke them', { keys: [key] })
          : ok({ site: {}, moved: true }, { keysRevoked: [key], keysKept: [] }),
    });
    render(show(<Team />, { teams: TEAMS }));
    const teams = card('More than one team');
    const to = await within(teams).findByLabelText('To the team');
    // The teams this person owns, other than the one the site is in.
    expect(within(to).getAllByRole('option').map((option) => option.textContent)).toEqual(['Empty', 'First']);
    await userEvent.selectOptions(to, 't_empty');
    await userEvent.click(within(teams).getByRole('button', { name: 'Move the site' }));

    const question = await within(teams).findByRole('group', { name: 'Keys on this site' });
    expect(question).toHaveFocus();
    expect(within(question).getByText('collector, on Progsity, with write:events')).toBeInTheDocument();
    expect(paid(calls())).toHaveLength(1);
    expect(paid(calls())[0]).toMatchObject({
      method: 'PUT',
      path: '/api/ee/sites/s_test/team',
      body: { teamId: 't_empty' },
    });

    await userEvent.click(within(question).getByRole('button', { name: 'Revoke them and go on' }));
    await waitFor(() => expect(paid(calls())).toHaveLength(2));
    expect(paid(calls())[1]?.body).toEqual({ teamId: 't_empty', revokeKeys: true });
    expect(await within(teams).findByRole('status')).toHaveTextContent('Moved to Empty.');
    expect(within(teams).queryByRole('group', { name: 'Keys on this site' })).toBeNull();
  });

  it('says who moves a site to somebody who does not own its team, and what is missing to an owner of one team', async () => {
    world({ features: ['*'] });
    const first = render(show(<Team />, { team: null, scopes: ['admin', 'read:identity', 'read:stats', 'write:events'] }));
    expect(await screen.findByText('Only an owner of the team a site is in moves it.')).toBeInTheDocument();
    first.unmount();
    render(show(<Team />));
    expect(
      await screen.findByText('To move this site, you would need to own another team to move it to.'),
    ).toBeInTheDocument();
  });

  it('goes back to the labelled feature, with the reason, when the key ran out while the page was open', async () => {
    world({
      features: ['*'],
      write: () =>
        refused(403, 'LICENSE_REQUIRED', 'This licence key has expired', {
          feature: 'teams',
          reason: 'expired',
        }),
    });
    render(show(<Team />, { teams: TEAMS }));
    const teams = card('More than one team');
    await userEvent.type(await within(teams).findByLabelText('Its name'), 'Clients');
    await userEvent.click(within(teams).getByRole('button', { name: 'Make the team' }));
    expect(await within(teams).findByText('The licence key on this install has expired.')).toBeInTheDocument();
    expect(within(teams).getByText('Part of Chokh Pro')).toBeInTheDocument();
    expect(within(teams).queryByRole('textbox')).toBeNull();
  });
});

// Single sign-on is part of Chokh Pro, and the Team page is where somebody
// signed in reads about it (rule 10). With it on, this is where an account
// connects itself.
describe('single sign-on', () => {
  it('is named and described where it is off, with nothing to press, for a viewer too', async () => {
    world();
    render(show(<Team />, { team: 'viewer' }));
    const sso = card('Single sign-on');
    expect(within(sso).getByText('Part of Chokh Pro')).toBeInTheDocument();
    expect(within(sso).getByText(/nobody is let in because of an address alone/)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(sso).queryByRole('button')).toBeNull();
  });

  it('connects the account that is signed in by sending the browser where the server says', async () => {
    const calls = world({
      identity: { connected: false, canDisconnect: false },
      write: (call) =>
        call.path === '/api/ee/oidc/link'
          ? ok({ url: 'https://provider.example/authorize?state=abc' })
          : undefined,
    });
    const left: string[] = [];
    vi.spyOn(navigation, 'leave').mockImplementation((url) => void left.push(url));
    render(show(<Team />, { team: 'viewer' }));
    const sso = card('Single sign-on');
    expect(await within(sso).findByText('Your account is not connected yet.')).toBeInTheDocument();
    await userEvent.click(within(sso).getByRole('button', { name: 'Connect my account' }));
    await waitFor(() => expect(left).toEqual(['https://provider.example/authorize?state=abc']));
    // A POST with a body, which is what makes it this dashboard's own request.
    expect(calls().find((call) => call.path === '/api/ee/oidc/link')).toMatchObject({
      method: 'POST',
      body: {},
    });
  });

  it('disconnects an account that has a password, and not one whose only way in it is', async () => {
    let connected = true;
    const calls = world({
      identity: { connected: true, canDisconnect: true },
      write: (call) => {
        if (call.path === '/api/ee/oidc/identity' && call.method === 'DELETE') {
          connected = false;
          return ok({ connected: false });
        }
        return undefined;
      },
    });
    const first = render(show(<Team />));
    const sso = card('Single sign-on');
    expect(await within(sso).findByText(/You can sign in with single sign-on, or with your password/)).toBeInTheDocument();
    await userEvent.click(within(sso).getByRole('button', { name: 'Disconnect' }));
    expect(await within(sso).findByRole('status')).toHaveTextContent('Disconnected.');
    expect(connected).toBe(false);
    expect(calls().some((call) => call.method === 'DELETE' && call.path === '/api/ee/oidc/identity')).toBe(true);
    first.unmount();

    vi.unstubAllGlobals();
    world({ identity: { connected: true, canDisconnect: false } });
    render(show(<Team />));
    const only = card('Single sign-on');
    expect(await within(only).findByText(/It has no password, so it stays connected/)).toBeInTheDocument();
    expect(within(only).getByRole('button', { name: 'Disconnect' })).toBeDisabled();
  });
});
