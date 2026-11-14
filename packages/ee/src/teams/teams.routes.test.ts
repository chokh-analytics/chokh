import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, type ServerExtension } from '@chokh/server';
import { createMemoryStore } from '@chokh/server/store/memory';
import { defaultSiteSettings } from '@chokh/server/store';
import type { AuditEntry, Role } from '@chokh/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildExtension } from '../extension.js';
import { ALL_FEATURES, type LicensePayload } from '../license/payload.js';
import { publicKeyToBase64, signLicense } from '../license/token.js';
import { MAX_TEAMS_OWNED, TEAMS_FEATURE } from './teams.routes.js';

// More than one team, over HTTP against the real server: who may make a team,
// delete one and move a site, what each leaves behind, and that with no key
// all three are refused for the key and nothing else stops working.

const SITE_ID = 's_test';
const TEAM_ID = 'default';
const PASSWORD = 'a-password-long-enough';
const DAY = 86_400;

function licensed(): ServerExtension {
  const generated = generateKeyPairSync('ed25519');
  const issuedAt = Math.floor(Date.now() / 1000);
  const license: LicensePayload = {
    v: 1,
    id: 'lic_teams',
    licensee: 'A Test Company Ltd.',
    plan: 'pro',
    features: [ALL_FEATURES],
    seats: null,
    sites: null,
    issuedAt,
    expiresAt: issuedAt + 365 * DAY,
  };
  return buildExtension({
    raw: signLicense(
      generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      license,
    ),
    publicKeys: [
      publicKeyToBase64(generated.publicKey.export({ format: 'pem', type: 'spki' }).toString()),
    ],
  });
}

function unlicensed(): ServerExtension {
  return buildExtension({ raw: undefined, publicKeys: [] });
}

interface Person {
  cookie: string;
  userId: string;
}

interface Install {
  app: FastifyInstance;
  store: ReturnType<typeof createMemoryStore>;
  owner: Person;
  account(email: string, teamId: string, role: Role): Promise<Person>;
  send(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    who: Person | { authorization: string } | null,
    payload?: object,
  ): Promise<{ status: number; code: string | undefined; data: Record<string, unknown>; meta: Record<string, unknown>; details: unknown }>;
  log(scope: { kind: 'team' | 'site'; id: string }, action: string): Promise<AuditEntry[]>;
}

async function install(extension: ServerExtension): Promise<Install> {
  const store = createMemoryStore();
  const app = await buildApp({ store, extensions: [extension] });
  await app.ready();
  const cookieOf = (response: { cookies: Array<{ name: string; value: string }> }): string =>
    `${response.cookies[0]?.name}=${response.cookies[0]?.value}`;
  const idOf = (body: string): string =>
    (JSON.parse(body) as { data: { user: { id: string } } }).data.user.id;

  const first = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'owner@test.example', password: PASSWORD },
  });
  const owner: Person = { cookie: cookieOf(first), userId: idOf(first.body) };
  await store.createSite({
    id: SITE_ID,
    name: 'Test site',
    domains: ['test.example'],
    teamId: TEAM_ID,
    settings: defaultSiteSettings({ timezone: 'UTC' }),
  });

  return {
    app,
    store,
    owner,
    async account(email, teamId, role) {
      const added = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: PASSWORD },
        headers: { cookie: owner.cookie },
      });
      const userId = idOf(added.body);
      await store.setTeamMember(teamId, { userId, role, identity: role === 'owner' });
      const signedIn = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: PASSWORD },
      });
      return { cookie: cookieOf(signedIn), userId };
    },
    async send(method, url, who, payload) {
      const headers: Record<string, string> =
        who === null ? {} : 'cookie' in who ? { cookie: who.cookie } : { authorization: who.authorization };
      const response = await app.inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      const body = JSON.parse(response.body) as {
        data?: Record<string, unknown>;
        meta?: Record<string, unknown>;
        error?: { code?: string; details?: unknown };
      };
      return {
        status: response.statusCode,
        code: body.error?.code,
        data: body.data ?? {},
        meta: body.meta ?? {},
        details: body.error?.details,
      };
    },
    async log(scope, action) {
      return (await store.auditPage({ scope, limit: 200 })).rows.filter((row) => row.action === action);
    },
  };
}

let here: Install;

afterEach(async () => {
  await here.app.close();
});

async function make(name: string, who: Person = here.owner): Promise<string> {
  const made = await here.send('POST', '/api/ee/teams', who, { name });
  if (made.status !== 201) throw new Error(`making ${name} answered ${made.status} ${made.code}`);
  return (made.data['team'] as { id: string }).id;
}

describe('with no licence key', () => {
  beforeEach(async () => {
    here = await install(unlicensed());
  });

  it('refuses all three for the key, to somebody who would otherwise be allowed, and changes nothing', async () => {
    await here.store.createTeam({
      id: 't_second',
      name: 'Second',
      members: [{ userId: here.owner.userId, role: 'owner', identity: true }],
    });
    for (const [method, url, body] of [
      ['POST', '/api/ee/teams', { name: 'Another' }],
      ['DELETE', '/api/ee/teams/t_second', undefined],
      ['PUT', `/api/ee/sites/${SITE_ID}/team`, { teamId: 't_second' }],
    ] as const) {
      const answer = await here.send(method, url, here.owner, body);
      expect([answer.status, answer.code]).toEqual([403, 'LICENSE_REQUIRED']);
      expect(answer.details).toEqual({ feature: TEAMS_FEATURE, reason: 'missing' });
    }
    expect((await here.store.teamsForUser(here.owner.userId)).map((team) => team.id).sort()).toEqual([
      TEAM_ID,
      't_second',
    ]);
    expect((await here.store.site(SITE_ID))?.teamId).toBe(TEAM_ID);
  });

  it('tells somebody who owns nothing that, and not which paid feature lives here', async () => {
    const editor = await here.account('editor@test.example', TEAM_ID, 'editor');
    for (const [method, url, body] of [
      ['POST', '/api/ee/teams', { name: 'Another' }],
      ['DELETE', `/api/ee/teams/${TEAM_ID}`, undefined],
      ['PUT', `/api/ee/sites/${SITE_ID}/team`, { teamId: TEAM_ID }],
    ] as const) {
      const answer = await here.send(method, url, editor, body);
      expect([answer.status, answer.code]).toEqual([403, 'FORBIDDEN']);
    }
  });

  // What is paid is the three acts. A team that exists is the core's.
  it('takes nothing away from a team that already exists', async () => {
    await here.store.createTeam({
      id: 't_second',
      name: 'Second',
      members: [{ userId: here.owner.userId, role: 'owner', identity: true }],
    });
    expect((await here.send('GET', '/api/teams/t_second/members', here.owner)).status).toBe(200);
    const site = await here.send('POST', '/api/sites', here.owner, {
      name: 'In the second team',
      domains: ['second.example'],
      teamId: 't_second',
    });
    expect(site.status).toBe(201);
    const invited = await here.send('POST', '/api/teams/t_second/invitations', here.owner, {
      email: 'ada@test.example',
      role: 'viewer',
    });
    expect(invited.status).toBe(201);
  });
});

describe('making a team', () => {
  beforeEach(async () => {
    here = await install(licensed());
  });

  it('is done by somebody who owns a team, who then owns the new one alone', async () => {
    const made = await here.send('POST', '/api/ee/teams', here.owner, { name: '  Clients  ' });
    expect(made.status).toBe(201);
    const team = made.data['team'] as { id: string; name: string; role: string };
    expect(team).toEqual({ id: expect.stringMatching(/^t_[0-9a-f]{8}$/), name: 'Clients', role: 'owner' });
    expect(await here.store.team(team.id)).toEqual({
      id: team.id,
      name: 'Clients',
      members: [{ userId: here.owner.userId, role: 'owner', identity: true }],
    });
    // It is theirs in the answer the dashboard boots from.
    const me = await here.send('GET', '/api/me', here.owner);
    expect(me.data['teams']).toContainEqual({ id: team.id, name: 'Clients', role: 'owner' });
    // And it is in the new team's own log, by whom.
    expect(await here.log({ kind: 'team', id: team.id }, 'team:create')).toEqual([
      expect.objectContaining({
        teamId: team.id,
        actor: { kind: 'session', id: here.owner.userId, email: 'owner@test.example' },
        route: 'POST /api/ee/teams',
        target: team.id,
        fields: ['name: Clients'],
      }),
    ]);
  });

  it('is not done by an editor, by a key, by nobody, or without a name', async () => {
    const editor = await here.account('editor@test.example', TEAM_ID, 'editor');
    const minted = await here.send('POST', `/api/sites/${SITE_ID}/keys`, here.owner, {
      name: 'admin',
      scopes: ['admin'],
    });
    const key = { authorization: `Bearer ${(minted.data['once'] as { token: string }).token}` };
    expect((await here.send('POST', '/api/ee/teams', editor, { name: 'X' })).code).toBe('FORBIDDEN');
    expect((await here.send('POST', '/api/ee/teams', key, { name: 'X' })).code).toBe('FORBIDDEN');
    expect((await here.send('POST', '/api/ee/teams', null, { name: 'X' })).status).toBe(401);
    expect((await here.send('POST', '/api/ee/teams', here.owner, { name: '   ' })).code).toBe('INVALID_BODY');
    expect((await here.store.teamsForUser(here.owner.userId)).map((team) => team.id)).toEqual([TEAM_ID]);
  });

  it('stops at a number of teams nobody needs', async () => {
    for (let index = 1; index < MAX_TEAMS_OWNED; index += 1) {
      await here.store.createTeam({
        id: `t_${index}`,
        name: `Team ${index}`,
        members: [{ userId: here.owner.userId, role: 'owner', identity: true }],
      });
    }
    const refused = await here.send('POST', '/api/ee/teams', here.owner, { name: 'One too many' });
    expect([refused.status, refused.code]).toEqual([409, 'TEAM_LIMIT']);
  });
});

describe('deleting a team', () => {
  beforeEach(async () => {
    here = await install(licensed());
  });

  it('takes the team and the invitations waiting on it, and is recorded', async () => {
    const teamId = await make('Clients');
    const invited = await here.send('POST', `/api/teams/${teamId}/invitations`, here.owner, {
      email: 'ada@test.example',
      role: 'viewer',
    });
    const sent = {
      id: (invited.data['invitation'] as { id: string }).id,
      token: (invited.data['once'] as { token: string }).token,
    };

    const gone = await here.send('DELETE', `/api/ee/teams/${teamId}`, here.owner);
    expect([gone.status, gone.data]).toEqual([200, { deleted: true }]);
    expect(await here.store.team(teamId)).toBeNull();
    // The invitation went with it: the row is gone, and its link opens nothing.
    expect(await here.store.invitation(sent.id)).toBeNull();
    const looked = await here.send('POST', '/api/invitations/lookup', null, { token: sent.token });
    expect(looked.status).toBeGreaterThanOrEqual(400);
    expect(await here.store.userByEmail('ada@test.example')).toBeNull();
    expect(await here.log({ kind: 'team', id: teamId }, 'team:delete')).toEqual([
      expect.objectContaining({ target: teamId, fields: ['name: Clients', 'members: 1'] }),
    ]);
  });

  it('never takes the default team, and never one that still holds a site', async () => {
    const kept = await here.send('DELETE', `/api/ee/teams/${TEAM_ID}`, here.owner);
    expect([kept.status, kept.code]).toEqual([409, 'DEFAULT_TEAM']);

    const teamId = await make('Clients');
    await here.store.createSite({
      id: 's_client',
      name: 'A client',
      domains: ['client.example'],
      teamId,
      settings: defaultSiteSettings({ timezone: 'UTC' }),
    });
    const guest = await here.account('guest@test.example', teamId, 'viewer');
    await here.store.changeTeamMember(teamId, guest.userId, null);
    await here.store.setSiteMember({ siteId: 's_client', userId: guest.userId, role: 'viewer', identity: false });

    const held = await here.send('DELETE', `/api/ee/teams/${teamId}`, here.owner);
    expect([held.status, held.code]).toEqual([409, 'TEAM_HAS_SITES']);
    // Nothing of it was touched: the team, its site, the role held on the site.
    expect((await here.store.team(teamId))?.members).toHaveLength(1);
    expect(await here.store.siteMembers('s_client')).toHaveLength(1);
    expect(await here.log({ kind: 'team', id: teamId }, 'team:delete')).toEqual([]);
  });

  it('is done by an owner of that team and nobody else', async () => {
    const teamId = await make('Clients');
    const other = await here.account('other@test.example', TEAM_ID, 'owner');
    const refused = await here.send('DELETE', `/api/ee/teams/${teamId}`, other);
    expect([refused.status, refused.code]).toEqual([403, 'FORBIDDEN']);
    expect(await here.store.team(teamId)).not.toBeNull();
    expect((await here.send('DELETE', '/api/ee/teams/t_nowhere', here.owner)).status).toBe(404);
  });

  // The store looks for a site and then deletes, and a site can be created in
  // between. The route looks again once the team is gone.
  it('puts the team back, as it was, when a site was created in it at the same instant', async () => {
    const teamId = await make('Clients');
    const colleague = await here.account('colleague@test.example', teamId, 'editor');
    const deleteTeam = here.store.deleteTeam.bind(here.store);
    here.store.deleteTeam = async (id: string) => {
      await deleteTeam(id);
      // What a creation that passed its own check a moment ago now writes.
      await here.store.createSite({
        id: 's_late',
        name: 'Created at that instant',
        domains: ['late.example'],
        teamId: id,
        settings: defaultSiteSettings({ timezone: 'UTC' }),
      });
    };
    const answer = await here.send('DELETE', `/api/ee/teams/${teamId}`, here.owner);
    here.store.deleteTeam = deleteTeam;

    expect([answer.status, answer.code]).toEqual([409, 'TEAM_HAS_SITES']);
    expect(await here.store.team(teamId)).toEqual({
      id: teamId,
      name: 'Clients',
      members: [
        { userId: here.owner.userId, role: 'owner', identity: true },
        { userId: colleague.userId, role: 'editor', identity: false },
      ],
    });
    // The site is nobody's orphan: its team's owner reads it.
    expect((await here.send('GET', '/api/sites/s_late', here.owner)).status).toBe(200);
    expect(await here.log({ kind: 'team', id: teamId }, 'team:delete')).toEqual([]);
  });
});

describe('moving a site to another team', () => {
  let teamId: string;

  beforeEach(async () => {
    here = await install(licensed());
    teamId = await make('Clients');
  });

  const move = (who: Parameters<Install['send']>[2], body: object = { teamId }) =>
    here.send('PUT', `/api/ee/sites/${SITE_ID}/team`, who, body);

  it('changes whose team reads it at once, leaves the roles held on the site, and is in three logs', async () => {
    const viewer = await here.account('viewer@test.example', TEAM_ID, 'viewer');
    const client = await here.account('client@test.example', teamId, 'viewer');
    const guest = await here.account('guest@test.example', teamId, 'viewer');
    await here.store.changeTeamMember(teamId, guest.userId, null);
    await here.store.setSiteMember({ siteId: SITE_ID, userId: guest.userId, role: 'editor', identity: false });
    const reads = async (who: Person) => (await here.send('GET', `/api/sites/${SITE_ID}`, who)).status;
    expect([await reads(viewer), await reads(client), await reads(guest)]).toEqual([200, 403, 200]);

    const moved = await move(here.owner);
    expect(moved.status).toBe(200);
    expect(moved.data['moved']).toBe(true);
    expect((moved.data['site'] as { teamId: string }).teamId).toBe(teamId);
    expect((await here.store.site(SITE_ID))?.teamId).toBe(teamId);
    // The same cookies, the next request: the old team's viewer is out, the
    // new team's is in, and the role held on the site itself went with it.
    expect([await reads(viewer), await reads(client), await reads(guest)]).toEqual([403, 200, 200]);
    expect(await here.store.siteMembers(SITE_ID)).toEqual([
      { siteId: SITE_ID, userId: guest.userId, role: 'editor', identity: false },
    ]);

    const row = expect.objectContaining({
      action: 'site:move',
      route: 'PUT /api/ee/sites/:siteId/team',
      target: SITE_ID,
      fields: [`team: ${TEAM_ID} > ${teamId}`],
      actor: { kind: 'session', id: here.owner.userId, email: 'owner@test.example' },
    });
    expect(await here.log({ kind: 'team', id: TEAM_ID }, 'site:move')).toEqual([row]);
    expect(await here.log({ kind: 'team', id: teamId }, 'site:move')).toEqual([row]);
    expect(await here.log({ kind: 'site', id: SITE_ID }, 'site:move')).toEqual([row]);
  });

  it('is done by an owner of both teams, and by nobody who owns only one', async () => {
    // Owns the team the site is in, and not the one it would go to.
    const here_only = await here.account('here@test.example', TEAM_ID, 'owner');
    const one = await move(here_only);
    expect([one.status, one.code]).toEqual([403, 'FORBIDDEN']);
    // Owns the team it would go to, and not the one the site is in.
    const there_only = await here.account('there@test.example', teamId, 'owner');
    const other = await move(there_only);
    expect([other.status, other.code]).toEqual([403, 'FORBIDDEN']);
    expect((await here.store.site(SITE_ID))?.teamId).toBe(TEAM_ID);
    expect(await here.log({ kind: 'site', id: SITE_ID }, 'site:move')).toEqual([]);
  });

  it('answers a team that is not there, a site that is not there, and a site already where it was sent', async () => {
    const nowhere = await move(here.owner, { teamId: 't_nowhere' });
    expect([nowhere.status, nowhere.code]).toEqual([404, 'UNKNOWN_TEAM']);
    const missing = await here.send('PUT', '/api/ee/sites/s_nowhere/team', here.owner, { teamId });
    expect([missing.status, missing.code]).toEqual([404, 'UNKNOWN_SITE']);
    expect((await move(here.owner, {})).code).toBe('INVALID_BODY');
    const same = await move(here.owner, { teamId: TEAM_ID });
    expect([same.status, same.data['moved']]).toEqual([200, false]);
    expect(await here.log({ kind: 'team', id: TEAM_ID }, 'site:move')).toEqual([]);
  });

  it('asks about keys made by somebody who will not administer the site afterwards', async () => {
    const colleague = await here.account('colleague@test.example', TEAM_ID, 'owner');
    const theirs = await here.send('POST', `/api/sites/${SITE_ID}/keys`, colleague, {
      name: 'collector',
      scopes: ['write:events'],
    });
    const mine = await here.send('POST', `/api/sites/${SITE_ID}/keys`, here.owner, {
      name: 'mine',
      scopes: ['read:stats'],
    });
    const theirKey = (theirs.data['key'] as { id: string }).id;
    const myKey = (mine.data['key'] as { id: string }).id;

    const asked = await move(here.owner);
    expect([asked.status, asked.code]).toEqual([409, 'KEYS_DECISION_REQUIRED']);
    // The colleague's key and not the mover's own: the mover owns both teams.
    expect(asked.details).toEqual({
      keys: [{ id: theirKey, name: 'collector', siteId: SITE_ID, scopes: ['write:events'] }],
    });
    expect(JSON.stringify(asked.details)).not.toContain((theirs.data['once'] as { token: string }).token);
    expect((await here.store.site(SITE_ID))?.teamId).toBe(TEAM_ID);

    const kept = await move(here.owner, { teamId, revokeKeys: false });
    expect(kept.status).toBe(200);
    expect(kept.meta).toEqual({
      keysRevoked: [],
      keysKept: [{ id: theirKey, name: 'collector', siteId: SITE_ID, scopes: ['write:events'] }],
    });
    expect((await here.store.apiKeys(SITE_ID)).map((key) => key.id).sort()).toEqual([theirKey, myKey].sort());
    expect((await here.log({ kind: 'site', id: SITE_ID }, 'site:move'))[0]?.fields).toEqual([
      `team: ${TEAM_ID} > ${teamId}`,
      'keys kept: 1',
      `key ${theirKey} "collector" on ${SITE_ID}`,
    ]);
  });

  it('revokes those keys when that is the answer, and no others', async () => {
    const colleague = await here.account('colleague@test.example', TEAM_ID, 'owner');
    const theirs = await here.send('POST', `/api/sites/${SITE_ID}/keys`, colleague, {
      name: 'collector',
      scopes: ['read:stats'],
    });
    const mine = await here.send('POST', `/api/sites/${SITE_ID}/keys`, here.owner, {
      name: 'mine',
      scopes: ['read:stats'],
    });
    const bearer = (answer: typeof theirs) => ({
      authorization: `Bearer ${(answer.data['once'] as { token: string }).token}`,
    });

    const moved = await move(here.owner, { teamId, revokeKeys: true });
    expect(moved.status).toBe(200);
    expect((moved.meta['keysRevoked'] as unknown[]).length).toBe(1);
    expect((await here.send('GET', `/api/sites/${SITE_ID}`, bearer(theirs))).status).toBe(401);
    expect((await here.send('GET', `/api/sites/${SITE_ID}`, bearer(mine))).status).toBe(200);
  });

  // The other half of the race the deletion guards: the team a site is being
  // moved to, deleted between the check and the write.
  it('puts the team back when it was deleted at the instant a site moved into it', async () => {
    const updateSite = here.store.updateSite.bind(here.store);
    here.store.updateSite = async (...args: Parameters<typeof updateSite>) => {
      // A deletion that looked, saw no site, and now removes the team.
      await here.store.deleteTeam(teamId);
      return updateSite(...args);
    };
    const moved = await move(here.owner);
    here.store.updateSite = updateSite;

    expect(moved.status).toBe(200);
    expect((await here.store.site(SITE_ID))?.teamId).toBe(teamId);
    expect((await here.store.team(teamId))?.members).toEqual([
      { userId: here.owner.userId, role: 'owner', identity: true },
    ]);
    expect((await here.send('GET', `/api/sites/${SITE_ID}`, here.owner)).status).toBe(200);
  });
});
