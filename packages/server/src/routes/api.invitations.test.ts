import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PASSWORD,
  SITE_ID,
  TEAM_ID,
  createHarness,
  envelope,
  expectFailure,
  testSite,
  type Harness,
} from './api.test-utils.js';
import { signHs256 } from '../lib/jwt.js';
import { ssoClaimsFor } from '../services/sso.service.js';
import { StoreQueryError, type Role } from '../store/AnalyticsStore.js';

// Invitations over HTTP (AN-TEAM01): who may send one to whom, what the link
// lets its holder do and only once, what it is worth when its sender no
// longer could have sent it, and that the token is in no row and no log.

const SIBLING = 's_sibling';
const SPARE_TEAM = 't_spare';
const WEEK = 7 * 86_400_000;
const NEW_PASSWORD = 'a-password-of-their-own';

let harness: Harness;
let logged: string[];

beforeEach(async () => {
  logged = [];
  harness = await createHarness({
    sites: [testSite(), testSite({ id: SIBLING, domains: ['sibling.example'] })],
    // Everything the server says, at its most talkative, kept for the cases
    // that read it.
    log: { level: 'trace', stream: { write: (line) => void logged.push(line) } },
  });
  await harness.store.createTeam({ id: SPARE_TEAM, name: 'Spare', members: [] });
});

afterEach(async () => {
  await harness.close();
});

interface Person {
  cookie: string;
  userId: string;
}

// An account is a registration and a sign-in, which share the limit on
// attempts from one address, so the clock moves on before each.
async function member(email: string, role: Role, identity = false): Promise<Person> {
  harness.setNow(harness.now() + 61_000);
  return harness.account({ email, role, identity });
}

async function guest(email: string): Promise<Person> {
  harness.setNow(harness.now() + 61_000);
  const made = await harness.account({ email, role: 'viewer', teamId: SPARE_TEAM });
  await harness.store.changeTeamMember(SPARE_TEAM, made.userId, null);
  return made;
}

interface Sent {
  id: string;
  token: string;
  link: string;
}

function post(url: string, payload: object, headers: Record<string, string> = {}) {
  return harness.app.inject({ method: 'POST', url, headers, payload });
}

async function invite(
  url: string,
  email: string,
  role: Role,
  cookie = harness.owner.cookie,
  identity = false,
): Promise<Sent> {
  const response = await post(url, { email, role, identity }, { cookie });
  if (response.statusCode !== 201) {
    throw new Error(`invite(${email}) answered ${response.statusCode}: ${response.body}`);
  }
  const data = envelope<{ invitation: { id: string }; once: { token: string; link: string } }>(
    response.body,
  ).data;
  return { id: data?.invitation.id ?? '', token: data?.once.token ?? '', link: data?.once.link ?? '' };
}

const TEAM_INVITES = `/api/teams/${TEAM_ID}/invitations`;
const SITE_INVITES = `/api/sites/${SITE_ID}/invitations`;

function lookup(token: string) {
  return post('/api/invitations/lookup', { token });
}

function accept(token: string, body: object = {}, headers: Record<string, string> = {}) {
  return post('/api/invitations/accept', { token, ...body }, headers);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function get(url: string, cookie: string) {
  return harness.app.inject({ method: 'GET', url, headers: { cookie } });
}

describe('sending an invitation', () => {
  it('answers with the link once, and keeps only the hash of its token', async () => {
    const response = await post(
      TEAM_INVITES,
      { email: 'Ada@Example.com', role: 'editor', identity: true },
      { cookie: harness.owner.cookie },
    );
    expect(response.statusCode).toBe(201);
    const data = envelope<{
      invitation: Record<string, unknown>;
      once: { token: string; link: string };
    }>(response.body).data;
    const token = data?.once.token ?? '';
    expect(token).toMatch(/^chi_[A-Za-z0-9_-]{43}$/);
    // A path and a fragment: the page knows its own address, and a fragment
    // is never sent to a server.
    expect(data?.once.link).toBe(`/invite#${token}`);
    expect(data?.invitation).toEqual({
      id: data?.invitation['id'],
      email: 'ada@example.com',
      scope: { kind: 'team', id: TEAM_ID },
      role: 'editor',
      identity: true,
      invitedBy: harness.owner.userId,
      createdAt: harness.now(),
      expiresAt: harness.now() + WEEK,
      state: 'pending',
      usable: true,
    });

    // What is stored finds it by the hash, and holds the token nowhere.
    const stored = await harness.store.invitationByHash(sha256(token));
    expect(stored?.id).toBe(data?.invitation['id']);
    expect(JSON.stringify(stored)).not.toContain(token);
    // And no later answer carries it, or its hash.
    const list = await get(TEAM_INVITES, harness.owner.cookie);
    expect(envelope<{ invitations: unknown[] }>(list.body).data?.invitations).toHaveLength(1);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain(sha256(token));
    expect(list.body).not.toContain('tokenHash');
  });

  // Which host this dashboard is reached at is the dashboard's to know. A
  // Host header is the caller's to write, and a link built from one would
  // send the invited person wherever the caller liked.
  it('never builds the link from what the request says its host is', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: TEAM_INVITES,
      headers: {
        cookie: harness.owner.cookie,
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        origin: 'https://evil.example',
      },
      payload: { email: 'ada@test.example', role: 'viewer' },
    });
    expect(response.statusCode).toBe(201);
    const once = envelope<{ once: { token: string; link: string } }>(response.body).data?.once;
    expect(once?.link).toBe(`/invite#${once?.token}`);
    expect(response.body).not.toContain('evil.example');
  });

  // MongoDB before its migration: the index that makes an invitation single
  // per address is not there, so the store refuses to write one and says what
  // to run. Over HTTP that is the operator's to fix, not the caller's.
  it('answers 503 with the command to run when the store says it has not been migrated', async () => {
    const createInvitation = harness.store.createInvitation.bind(harness.store);
    harness.store.createInvitation = () =>
      Promise.reject(
        new StoreQueryError(
          'MIGRATION_REQUIRED',
          'The invitations collection has not been migrated. Run: node packages/store-mongo/dist/migrate.js --apply',
        ),
      );
    try {
      const response = await post(
        TEAM_INVITES,
        { email: 'ada@test.example', role: 'viewer' },
        { cookie: harness.owner.cookie },
      );
      expectFailure(response, 503, 'MIGRATION_REQUIRED');
      expect(response.body).toContain('migrate.js --apply');
      expect(response.body).not.toContain('chi_');
    } finally {
      harness.store.createInvitation = createInvitation;
    }
    // Nothing was sent, so nothing went into the log of the team either.
    expect((await harness.store.auditPage({ scope: { kind: 'team', id: TEAM_ID }, limit: 5 })).rows).toEqual([]);
  });

  it('is for an owner of the team, a person, and nobody else', async () => {
    const editor = await member('editor@test.example', 'editor');
    const body = { email: 'new@test.example', role: 'viewer' };
    expectFailure(await post(TEAM_INVITES, body), 401, 'UNAUTHENTICATED');
    expectFailure(await post(TEAM_INVITES, body, { cookie: editor.cookie }), 403, 'FORBIDDEN');
    expectFailure(
      await post(TEAM_INVITES, body, { authorization: await harness.key(['admin']) }),
      403,
      'FORBIDDEN',
    );
    expectFailure(await get(TEAM_INVITES, editor.cookie), 403, 'FORBIDDEN');
    expectFailure(
      await post('/api/teams/t_nothing/invitations', body, { cookie: harness.owner.cookie }),
      404,
      'UNKNOWN_TEAM',
    );
    expect(await harness.store.openInvitations({ kind: 'team', id: TEAM_ID })).toEqual([]);
  });

  it('refuses what would do nothing or cannot be', async () => {
    const editor = await member('editor@test.example', 'editor');
    const owner = { cookie: harness.owner.cookie };
    expectFailure(await post(TEAM_INVITES, { email: 'not-an-address', role: 'viewer' }, owner), 400, 'INVALID_BODY');
    expectFailure(await post(TEAM_INVITES, { email: 'a@test.example', role: 'admin' }, owner), 400, 'INVALID_BODY');

    await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    // One waiting per address on one team, however it is spelled.
    expectFailure(
      await post(TEAM_INVITES, { email: 'ADA@test.example', role: 'editor' }, owner),
      409,
      'INVITATION_EXISTS',
    );
    // On another scope the same address is another invitation.
    await invite(SITE_INVITES, 'ada@test.example', 'viewer');
    // Somebody already in the team is changed from the list, not invited.
    expectFailure(
      await post(TEAM_INVITES, { email: 'editor@test.example', role: 'owner' }, owner),
      409,
      'ALREADY_MEMBER',
    );
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: editor.userId, role: 'viewer', identity: false });
    expectFailure(
      await post(SITE_INVITES, { email: 'editor@test.example', role: 'owner' }, owner),
      409,
      'ALREADY_MEMBER',
    );
  });

  it('is refused for an address an account signed in by another application holds', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/sso',
      payload: {
        token: signHs256(
          'test-sso-secret-not-a-real-key-000000',
          ssoClaimsFor({
            sub: 'staff_3',
            email: 'staff@elsewhere.example',
            teamId: SPARE_TEAM,
            role: 'viewer',
            now: harness.now(),
            lifetimeSeconds: 300,
          }),
        ),
      },
    });
    for (const url of [TEAM_INVITES, SITE_INVITES]) {
      expectFailure(
        await post(url, { email: 'staff@elsewhere.example', role: 'viewer' }, { cookie: harness.owner.cookie }),
        409,
        'MANAGED_BY_SSO',
      );
    }
  });

  it('to one site is for somebody with admin on it, a person, on that site only', async () => {
    const siteOwner = await guest('site-owner@test.example');
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: siteOwner.userId, role: 'owner', identity: true });
    const editor = await member('editor@test.example', 'editor');
    const body = { email: 'new@test.example', role: 'owner', identity: true };

    expectFailure(await post(SITE_INVITES, body, { cookie: editor.cookie }), 403, 'SCOPE_REQUIRED');
    expectFailure(
      await post(SITE_INVITES, body, { authorization: await harness.key(['admin']) }),
      403,
      'FORBIDDEN',
    );
    expect((await post(SITE_INVITES, body, { cookie: siteOwner.cookie })).statusCode).toBe(201);
    // Their own site, not the one beside it and not the team.
    expectFailure(
      await post(`/api/sites/${SIBLING}/invitations`, body, { cookie: siteOwner.cookie }),
      403,
      'SITE_FORBIDDEN',
    );
    expectFailure(await post(TEAM_INVITES, body, { cookie: siteOwner.cookie }), 403, 'FORBIDDEN');
    const list = await get(SITE_INVITES, siteOwner.cookie);
    expect(envelope<{ invitations: { email: string }[] }>(list.body).data?.invitations).toEqual([
      expect.objectContaining({ email: 'new@test.example', role: 'owner', state: 'pending' }),
    ]);
  });

  it('can be taken back, once, by whoever may send one there', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    const url = `${TEAM_INVITES}/${sent.id}`;
    // Not through another team's or a site's list.
    expectFailure(
      await harness.app.inject({ method: 'DELETE', url: `${SITE_INVITES}/${sent.id}`, headers: { cookie: harness.owner.cookie } }),
      404,
      'UNKNOWN_INVITATION',
    );
    const revoked = await harness.app.inject({ method: 'DELETE', url, headers: { cookie: harness.owner.cookie } });
    expect(revoked.statusCode).toBe(200);
    expect(envelope<{ invitation: { state: string } }>(revoked.body).data?.invitation.state).toBe('revoked');
    expectFailure(
      await harness.app.inject({ method: 'DELETE', url, headers: { cookie: harness.owner.cookie } }),
      409,
      'INVITATION_CLOSED',
    );
    expectFailure(await lookup(sent.token), 410, 'INVITATION_REVOKED');
    expectFailure(await accept(sent.token, { password: NEW_PASSWORD }), 410, 'INVITATION_REVOKED');
    expect(await harness.store.userByEmail('ada@test.example')).toBeNull();
    // And the address can be invited again.
    await invite(TEAM_INVITES, 'ada@test.example', 'editor');
  });
});

describe('using an invitation', () => {
  it('shows whoever holds the link what it is for before they type anything', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'editor', harness.owner.cookie, true);
    const response = await lookup(sent.token);
    expect(response.statusCode).toBe(200);
    expect(envelope<{ invitation: unknown }>(response.body).data?.invitation).toEqual({
      email: 'ada@test.example',
      scope: { kind: 'team', id: TEAM_ID, name: 'Test team' },
      role: 'editor',
      identity: true,
      invitedBy: 'owner@test.example',
      expiresAt: harness.now() + WEEK,
      accountExists: false,
    });
    expectFailure(await lookup('chi_this-token-was-never-made-by-anybody-0000000'), 404, 'INVITATION_NOT_FOUND');
    expectFailure(await post('/api/invitations/lookup', { token: 'short' }), 400, 'INVALID_BODY');
    expectFailure(await post('/api/invitations/lookup', {}), 400, 'INVALID_BODY');
  });

  it('makes the account, with the password its owner chose, signs them in, and gives exactly the role that was picked', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'editor');
    const accepted = await accept(sent.token, { password: NEW_PASSWORD, name: 'Ada' });
    expect(accepted.statusCode).toBe(201);
    const data = envelope<{ user: { id: string; email: string; name: string }; created: boolean }>(
      accepted.body,
    ).data;
    expect(data).toMatchObject({
      user: { email: 'ada@test.example', name: 'Ada' },
      created: true,
      scope: { kind: 'team', id: TEAM_ID },
      role: 'editor',
    });
    expect(accepted.body).not.toContain('passwordHash');

    // Signed in by the answer, as an editor and nothing more.
    const cookie = `${accepted.cookies[0]?.name}=${accepted.cookies[0]?.value}`;
    const site = await get(`/api/sites/${SITE_ID}`, cookie);
    expect(envelope<{ scopes: string[] }>(site.body).data?.scopes).toEqual(['read:stats', 'write:events']);
    expectFailure(await get(`/api/sites/${SITE_ID}/keys`, cookie), 403, 'SCOPE_REQUIRED');
    // The password is theirs: it signs them in, and the owner never knew it.
    harness.setNow(harness.now() + 61_000);
    expect(await harness.signIn('ada@test.example', NEW_PASSWORD)).toContain('chokh_session=');
    expect((await harness.store.team(TEAM_ID))?.members.find((row) => row.userId === data?.user.id)).toEqual({
      userId: data?.user.id,
      role: 'editor',
      identity: false,
    });
  });

  it('is used once', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    expect((await accept(sent.token, { password: NEW_PASSWORD })).statusCode).toBe(201);
    expectFailure(await accept(sent.token, { password: 'another-password-altogether' }), 410, 'INVITATION_USED');
    expectFailure(await lookup(sent.token), 410, 'INVITATION_USED');
    // The second attempt changed nothing: the first password still signs in.
    harness.setNow(harness.now() + 61_000);
    expect(await harness.signIn('ada@test.example', NEW_PASSWORD)).toContain('chokh_session=');
    expect(await harness.store.openInvitations({ kind: 'team', id: TEAM_ID })).toEqual([]);
  });

  it('answers exactly one of eight acceptances sent at once, and makes one account', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => accept(sent.token, { password: NEW_PASSWORD })),
    );
    expect(answers.filter((answer) => answer.statusCode === 201)).toHaveLength(1);
    expect(answers.filter((answer) => answer.statusCode === 410)).toHaveLength(7);
    const members = (await harness.store.team(TEAM_ID))?.members ?? [];
    expect(members).toHaveLength(2);
  });

  it('holds a new account to the password rule registration applies, and spends nothing on a refusal', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    expectFailure(await accept(sent.token), 400, 'PASSWORD_REQUIRED');
    const short = await accept(sent.token, { password: 'eleven-char' });
    expectFailure(short, 400, 'INVALID_BODY');
    // Which field, and never what it held.
    expect(envelope<unknown>(short.body).error).toMatchObject({ details: { fields: ['password'] } });
    expect(short.body).not.toContain('eleven-char');
    expect(short.body).not.toContain(sent.token);
    expect(await harness.store.userByEmail('ada@test.example')).toBeNull();
    // Still theirs to use.
    expect((await accept(sent.token, { password: NEW_PASSWORD })).statusCode).toBe(201);
  });

  it('is accepted only by the account that already has the address, signed in, and leaves its password alone', async () => {
    const ada = await guest('ada@test.example');
    const other = await guest('other@test.example');
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'editor');
    expect(envelope<{ invitation: { accountExists: boolean } }>((await lookup(sent.token)).body).data?.invitation.accountExists).toBe(true);

    // The link alone is not a way into somebody who is already here.
    expectFailure(await accept(sent.token, { password: 'a-password-somebody-else-chose' }), 401, 'SIGN_IN_REQUIRED');
    expectFailure(await accept(sent.token, {}, { cookie: other.cookie }), 403, 'INVITATION_ADDRESS_MISMATCH');
    // A key is not the account either.
    expectFailure(
      await accept(sent.token, {}, { authorization: await harness.key(['admin']) }),
      401,
      'SIGN_IN_REQUIRED',
    );

    const accepted = await accept(sent.token, { password: 'a-password-somebody-else-chose' }, { cookie: ada.cookie });
    expect(accepted.statusCode).toBe(200);
    expect(envelope<{ created: boolean }>(accepted.body).data?.created).toBe(false);
    expect(accepted.cookies).toEqual([]);
    const site = await get(`/api/sites/${SITE_ID}`, ada.cookie);
    expect(envelope<{ scopes: string[] }>(site.body).data?.scopes).toEqual(['read:stats', 'write:events']);
    // The password in the body was for an account that did not need making,
    // and changed nothing: the one they had still signs them in, the other
    // does not.
    harness.setNow(harness.now() + 61_000);
    expect(await harness.signIn('ada@test.example', PASSWORD)).toContain('chokh_session=');
    expectFailure(
      await post('/api/auth/login', { email: 'ada@test.example', password: 'a-password-somebody-else-chose' }),
      401,
      'INVALID_CREDENTIALS',
    );
  });

  // Sent as a viewer's, and by the time it is opened the person has been made
  // an editor from the list. Using it would lower them, so it is refused, and
  // it is not spent by being refused.
  it('does not lower somebody who was given a role there after it was sent', async () => {
    const ada = await guest('ada@test.example');
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    await harness.app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/members/${ada.userId}`,
      headers: { cookie: harness.owner.cookie },
      payload: { role: 'editor' },
    });
    expectFailure(await accept(sent.token, {}, { cookie: ada.cookie }), 409, 'ALREADY_MEMBER');
    expect((await harness.store.team(TEAM_ID))?.members.find((row) => row.userId === ada.userId)?.role).toBe(
      'editor',
    );
    expect((await harness.store.invitation(sent.id))?.acceptedAt).toBeUndefined();
  });

  it('refuses somebody signed in as another account when the address has no account yet', async () => {
    const other = await guest('other@test.example');
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    expectFailure(
      await accept(sent.token, { password: NEW_PASSWORD }, { cookie: other.cookie }),
      403,
      'INVITATION_ADDRESS_MISMATCH',
    );
    expect(await harness.store.userByEmail('ada@test.example')).toBeNull();
  });

  it('to one site gives a role on that site and on nothing else', async () => {
    const sent = await invite(SITE_INVITES, 'ada@test.example', 'viewer', harness.owner.cookie, true);
    const accepted = await accept(sent.token, { password: NEW_PASSWORD });
    expect(accepted.statusCode).toBe(201);
    const cookie = `${accepted.cookies[0]?.name}=${accepted.cookies[0]?.value}`;
    const me = envelope<{ sites: { id: string; scopes: string[] }[]; teams: unknown[] }>(
      (await get('/api/me', cookie)).body,
    ).data;
    expect(me?.sites).toEqual([
      expect.objectContaining({ id: SITE_ID, scopes: ['read:identity', 'read:stats'] }),
    ]);
    expect(me?.teams).toEqual([]);
    expectFailure(await get(`/api/sites/${SIBLING}`, cookie), 403, 'SITE_FORBIDDEN');
  });

  // Looked at before anything is spent: a link to a site that has gone is
  // refused as that, the invitation is not used up, and no account is left
  // behind with nothing to belong to.
  it('to a site that is no longer there is refused without being spent, and makes no account', async () => {
    const sent = await invite(SITE_INVITES, 'ada@test.example', 'viewer');
    const site = harness.store.site.bind(harness.store);
    harness.store.site = (siteId: string) => (siteId === SITE_ID ? Promise.resolve(null) : site(siteId));
    try {
      expectFailure(await lookup(sent.token), 404, 'UNKNOWN_SITE');
      expectFailure(await accept(sent.token, { password: NEW_PASSWORD }), 404, 'UNKNOWN_SITE');
    } finally {
      harness.store.site = site;
    }
    expect(await harness.store.userByEmail('ada@test.example')).toBeNull();
    expect((await harness.store.invitation(sent.id))?.acceptedAt).toBeUndefined();
    // With the site there again, it is still theirs to use.
    expect((await accept(sent.token, { password: NEW_PASSWORD })).statusCode).toBe(201);
  });

  it('cannot be used once it has expired', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    harness.setNow(harness.now() + WEEK - 1);
    expect((await lookup(sent.token)).statusCode).toBe(200);
    harness.setNow(harness.now() + 1);
    expectFailure(await lookup(sent.token), 410, 'INVITATION_EXPIRED');
    expectFailure(await accept(sent.token, { password: NEW_PASSWORD }), 410, 'INVITATION_EXPIRED');
    expect(await harness.store.userByEmail('ada@test.example')).toBeNull();
    // Lapsed, it is still in the list, as lapsed, so whoever sent it sees why
    // nobody arrived; and the address can be invited again.
    // (A week on, the owner's own session has run out too: signed in afresh.)
    harness.setNow(harness.now() + 61_000);
    const owner = await harness.signIn('owner@test.example');
    const list = await get(TEAM_INVITES, owner);
    expect(envelope<{ invitations: { state: string }[] }>(list.body).data?.invitations[0]?.state).toBe('expired');
    await invite(TEAM_INVITES, 'ada@test.example', 'viewer', owner);
  });
});

describe('an invitation is never worth more than whoever sent it', () => {
  it('is revoked with the change when its sender is lowered through the dashboard', async () => {
    const second = await member('second@test.example', 'owner');
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'owner', second.cookie);
    const lowered = await harness.app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/members/${second.userId}`,
      headers: { cookie: harness.owner.cookie },
      payload: { role: 'viewer' },
    });
    expect(envelope<unknown>(lowered.body).meta).toMatchObject({ invitationsRevoked: 1 });
    expectFailure(await accept(sent.token, { password: NEW_PASSWORD }), 410, 'INVITATION_REVOKED');
  });

  // The check at the moment of use, for a change that did not come through
  // the dashboard and so revoked nothing: the row is still open in the store,
  // and the link still does not work.
  it('cannot be used when its sender could no longer send it, even if nothing revoked it', async () => {
    const second = await member('second@test.example', 'owner');
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'owner', second.cookie);
    await harness.store.changeTeamMember(TEAM_ID, second.userId, { role: 'editor', identity: false });
    expect((await harness.store.invitation(sent.id))?.revokedAt).toBeUndefined();
    // The list says so: still waiting, and not a link that would work. Worked
    // out when the list is read; nothing was written to say it.
    const list = await get(TEAM_INVITES, harness.owner.cookie);
    expect(envelope<{ invitations: unknown[] }>(list.body).data?.invitations).toEqual([
      expect.objectContaining({ id: sent.id, state: 'pending', usable: false }),
    ]);

    expectFailure(await lookup(sent.token), 410, 'INVITATION_REVOKED');
    expectFailure(await accept(sent.token, { password: NEW_PASSWORD }), 410, 'INVITATION_REVOKED');
    expect(await harness.store.userByEmail('ada@test.example')).toBeNull();
    expect((await harness.store.team(TEAM_ID))?.members.filter((row) => row.role === 'owner')).toHaveLength(1);
    // Not spent by the refusal either.
    expect((await harness.store.invitation(sent.id))?.acceptedAt).toBeUndefined();

    // And it is worth what its sender is worth at that moment, both ways:
    // given the right back before it expires, the link works again.
    await harness.store.changeTeamMember(TEAM_ID, second.userId, { role: 'owner', identity: true });
    expect(
      envelope<{ invitations: { usable: boolean }[] }>((await get(TEAM_INVITES, harness.owner.cookie)).body)
        .data?.invitations[0]?.usable,
    ).toBe(true);
    expect((await accept(sent.token, { password: NEW_PASSWORD })).statusCode).toBe(201);
  });

  it('cannot be used when its sender was removed altogether, or lost admin on the one site it is to', async () => {
    const second = await member('second@test.example', 'owner');
    const siteOwner = await guest('site-owner@test.example');
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: siteOwner.userId, role: 'owner', identity: true });
    const toTeam = await invite(TEAM_INVITES, 'ada@test.example', 'viewer', second.cookie);
    const toSite = await invite(SITE_INVITES, 'bea@test.example', 'owner', siteOwner.cookie, true);

    await harness.store.changeTeamMember(TEAM_ID, second.userId, null);
    await harness.store.setSiteMember({ siteId: SITE_ID, userId: siteOwner.userId, role: 'editor', identity: false });
    expectFailure(await accept(toTeam.token, { password: NEW_PASSWORD }), 410, 'INVITATION_REVOKED');
    expectFailure(await accept(toSite.token, { password: NEW_PASSWORD }), 410, 'INVITATION_REVOKED');
    expect(await harness.store.siteMembers(SITE_ID)).toHaveLength(1);
  });
});

describe('looking at and using an invitation, from one address', () => {
  it('is limited the way signing in is, on a count of its own', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    // A fresh minute, then ten are answered and the eleventh is not.
    harness.setNow(harness.now() + 61_000);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = attempt % 2 === 0 ? await lookup(sent.token) : await accept('chi_a-guess-at-a-token-that-nobody-made-00000000');
      expect(response.statusCode).not.toBe(429);
    }
    expectFailure(await lookup(sent.token), 429, 'RATE_LIMITED');
    expectFailure(await accept(sent.token, { password: NEW_PASSWORD }), 429, 'RATE_LIMITED');
    // Signing in is counted apart, so one does not shut the other.
    expect((await post('/api/auth/login', { email: 'nobody@test.example', password: 'x' })).statusCode).toBe(401);
    // And nothing was spent while it was shut.
    harness.setNow(harness.now() + 61_000);
    expect((await accept(sent.token, { password: NEW_PASSWORD })).statusCode).toBe(201);
  });
});

describe('the token of an invitation', () => {
  it('is in no line of the log and no row of the audit log, whatever was done with it', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'editor');
    const other = await invite(SITE_INVITES, 'bea@test.example', 'viewer');
    const hash = sha256(sent.token);

    // Everything a link's holder can do with it, the ways that fail included.
    await lookup(sent.token);
    await accept(sent.token);
    await accept(sent.token, { password: 'short' });
    // A body that is not JSON at all, with the token in it: what a parser
    // quotes back in its complaint is what would end up in a log.
    await harness.app.inject({
      method: 'POST',
      url: '/api/invitations/accept',
      headers: { 'content-type': 'application/json' },
      payload: `{"token": ${sent.token}, "password": "${NEW_PASSWORD}"`,
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/invitations/lookup',
      headers: { 'content-type': 'text/plain' },
      payload: `${sent.token}`,
    });
    expect((await accept(sent.token, { password: NEW_PASSWORD, name: 'Ada' })).statusCode).toBe(201);
    await accept(sent.token, { password: NEW_PASSWORD });
    await lookup(sent.token);
    await harness.app.inject({
      method: 'DELETE',
      url: `${SITE_INVITES}/${other.id}`,
      headers: { cookie: harness.owner.cookie },
    });
    await lookup(other.token);

    const log = logged.join('');
    // The server did log these requests: an empty log would prove nothing.
    expect(log).toContain('/api/invitations/accept');
    expect(log).toContain('/api/invitations/lookup');
    expect(logged.length).toBeGreaterThan(20);
    for (const secret of [sent.token, other.token, hash, sha256(other.token), NEW_PASSWORD]) {
      expect(log).not.toContain(secret);
      // Not even the start of it, which is what a parser quotes.
      expect(log).not.toContain(secret.slice(0, 12));
    }

    const rows = [
      ...(await harness.store.auditPage({ scope: { kind: 'team', id: TEAM_ID }, limit: 50 })).rows,
      ...(await harness.store.auditPage({ scope: { kind: 'site', id: SITE_ID }, limit: 50 })).rows,
    ];
    expect(rows.map((row) => row.action).sort()).toEqual([
      'invite:accept',
      'invite:create',
      'invite:create',
      'invite:revoke',
    ]);
    const written = JSON.stringify(rows);
    for (const secret of [sent.token, other.token, hash, sha256(other.token)]) {
      expect(written).not.toContain(secret);
    }
  });

  it('is named in the audit log by the id of its invitation, with who it was to and who used it', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'editor', harness.owner.cookie, true);
    const accepted = await accept(sent.token, { password: NEW_PASSWORD });
    const userId = envelope<{ user: { id: string } }>(accepted.body).data?.user.id;
    const rows = (await harness.store.auditPage({ scope: { kind: 'team', id: TEAM_ID }, limit: 10 })).rows;
    expect(rows.map((row) => [row.action, row.target, row.fields, row.actor.id])).toEqual([
      ['invite:accept', userId, [`invitation ${sent.id}`, 'role: none > editor+identity'], userId],
      [
        'invite:create',
        'ada@test.example',
        [`invitation ${sent.id}`, 'role: editor+identity'],
        harness.owner.userId,
      ],
    ]);
    expect(rows[0]?.route).toBe('POST /api/invitations/accept');
  });
});

// The three routes that start a session from what is in their body: signing
// in, registering, using an invitation. Nobody is signed in yet, and the
// danger is one being put there: a form on a neighbouring origin, sent as
// text/plain (which the body parser reads as JSON), posting a token and a
// password of its own, so that the browser ends up signed in to an account
// the neighbour chose. So these are held to coming from this dashboard with
// no session at all.
describe('a session started from a body, from somewhere that is not this dashboard', () => {
  it('is refused for an invitation: not as a form, and not from a neighbouring origin', async () => {
    const sent = await invite(TEAM_INVITES, 'ada@test.example', 'viewer');
    const body = JSON.stringify({ token: sent.token, password: NEW_PASSWORD });
    for (const headers of [
      // What a form can send, which this server would otherwise read as JSON.
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      // And JSON, from a script the browser says is not this origin.
      { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' },
      { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/invitations/accept',
        headers,
        payload: body,
      });
      expect([403, 415]).toContain(response.statusCode);
      expect(['CROSS_SITE_REQUEST', 'JSON_REQUIRED']).toContain(envelope<unknown>(response.body).error?.code);
      expect(response.cookies).toEqual([]);
    }
    // Nobody was made and nothing was spent.
    expect(await harness.store.userByEmail('ada@test.example')).toBeNull();
    expect((await harness.store.invitation(sent.id))?.acceptedAt).toBeUndefined();
    // From this dashboard it works: JSON, and the browser saying same origin.
    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/invitations/accept',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: body,
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('is refused for signing in and for registering the same way', async () => {
    const credentials = JSON.stringify({ email: 'owner@test.example', password: PASSWORD });
    for (const url of ['/api/auth/login', '/api/auth/register']) {
      for (const [headers, status, code] of [
        [{ 'content-type': 'text/plain' }, 415, 'JSON_REQUIRED'],
        [{ 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }, 403, 'CROSS_SITE_REQUEST'],
        [{ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 403, 'CROSS_SITE_REQUEST'],
      ] as const) {
        const response = await harness.app.inject({ method: 'POST', url, headers, payload: credentials });
        expectFailure(response, status, code);
        expect(response.cookies).toEqual([]);
      }
    }
    // Refused before it is counted: none of those used up the address's
    // attempts, and the real thing still signs in.
    harness.setNow(harness.now() + 61_000);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'text/plain' },
        payload: credentials,
      });
    }
    expect(await harness.signIn('owner@test.example', PASSWORD)).toContain('chokh_session=');
  });

  it('leaves the exchange another application enters through as it was', async () => {
    // Entered from another origin by design: a browser arriving from a
    // neighbour, or a stranger, with a token that application signed.
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sso?token=${signHs256(
        'test-sso-secret-not-a-real-key-000000',
        ssoClaimsFor({
          sub: 'staff_5',
          email: 'staff5@elsewhere.example',
          teamId: SPARE_TEAM,
          role: 'viewer',
          now: harness.now(),
          lifetimeSeconds: 300,
        }),
      )}`,
      headers: { accept: 'text/html', 'sec-fetch-site': 'same-site' },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/');
  });
});
