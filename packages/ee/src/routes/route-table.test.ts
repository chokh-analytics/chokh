import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CORE_ROUTES,
  buildApp,
  compareRoutes,
  routeKey,
  walkCrossSite,
  walkRouteTable,
  type RouteCaller,
  type ServerExtension,
} from '@chokh/server';
import { createMemoryStore } from '@chokh/server/store/memory';
import { defaultSiteSettings } from '@chokh/server/store';
import type { Role, Scope } from '@chokh/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExtension } from '../extension.js';
import { ALL_FEATURES, type LicensePayload } from '../license/payload.js';
import { publicKeyToBase64, signLicense } from '../license/token.js';
import { EE_ROUTES } from './route-table.js';

// Every paid route against every kind of caller, on an install with a key and
// on one without. The core's routes are walked by the core's own test; this
// one adds that the two tables together are every route this process
// registered when the paid half is loaded, so a route cannot arrive through
// an extension without a row either.

const SITE_ID = 's_test';
const OTHER_SITE = 's_elsewhere';
const TEAM_ID = 'default';
const OTHER_TEAM = 't_elsewhere';
const PASSWORD = 'a-password-long-enough';

const SCOPES_BY_ROLE: Record<Role, readonly Scope[]> = {
  owner: ['read:stats', 'read:identity', 'write:events', 'admin'],
  editor: ['read:stats', 'write:events'],
  viewer: ['read:stats'],
};

function licensedExtension(): ServerExtension {
  const generated = generateKeyPairSync('ed25519');
  const issuedAt = Math.floor(Date.now() / 1000);
  const license: LicensePayload = {
    v: 1,
    id: 'lic_route_table',
    licensee: 'A Test Company Ltd.',
    plan: 'pro',
    features: [ALL_FEATURES],
    seats: null,
    sites: null,
    issuedAt,
    expiresAt: issuedAt + 365 * 86_400,
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

interface Install {
  app: FastifyInstance;
  // The owner's session, for the walk that asks from the wrong place.
  owner: string;
  callers: RouteCaller[];
  registered: { method: string; url: string }[];
}

async function install(extension: ServerExtension): Promise<Install> {
  const store = createMemoryStore();
  const registered: { method: string; url: string }[] = [];
  const app = await buildApp({
    store,
    extensions: [extension],
    onRoute: (route) => registered.push(route),
  });
  await app.ready();

  const cookieOf = (response: { cookies: Array<{ name: string; value: string }> }): string =>
    `${response.cookies[0]?.name}=${response.cookies[0]?.value}`;

  const first = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'owner@test.example', password: PASSWORD },
  });
  const owner = cookieOf(first);
  const ownerId = (JSON.parse(first.body) as { data: { user: { id: string } } }).data.user.id;
  for (const [id, domain, teamId] of [
    [SITE_ID, 'test.example', TEAM_ID],
    [OTHER_SITE, 'elsewhere.example', OTHER_TEAM],
  ] as const) {
    await store.createSite({
      id,
      name: id,
      domains: [domain],
      teamId,
      settings: defaultSiteSettings({ timezone: 'UTC' }),
    });
  }
  await store.createTeam({ id: OTHER_TEAM, name: 'Elsewhere', members: [] });

  async function account(email: string, teamId: string, role: Role): Promise<string> {
    const added = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD },
      headers: { cookie: owner },
    });
    const userId = (JSON.parse(added.body) as { data: { user: { id: string } } }).data.user.id;
    await store.setTeamMember(teamId, { userId, role, identity: false });
    return cookieOf(
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } }),
    );
  }

  async function mint(siteId: string, scopes: Scope[]): Promise<string> {
    const minted = await app.inject({
      method: 'POST',
      url: `/api/sites/${siteId}/keys`,
      payload: { name: scopes.join(' '), scopes },
      headers: { cookie: owner },
    });
    const token = (JSON.parse(minted.body) as { data: { once: { token: string } } }).data.once.token;
    return `Bearer ${token}`;
  }

  const session = (name: string, cookie: string, role: Role | null): RouteCaller => ({
    name,
    headers: { cookie },
    principal: 'session',
    scopes: role === null ? null : SCOPES_BY_ROLE[role],
    ownsTeam: role === 'owner',
    ownsAnyTeam: role === 'owner',
  });
  const key = (name: string, authorization: string, scopes: readonly Scope[] | null): RouteCaller => ({
    name,
    headers: { authorization },
    principal: 'key',
    scopes,
    ownsTeam: false,
    ownsAnyTeam: false,
  });

  const viewer = await account('viewer@test.example', TEAM_ID, 'viewer');
  const editor = await account('editor@test.example', TEAM_ID, 'editor');
  const stranger = await account('stranger@test.example', OTHER_TEAM, 'owner');
  const reads = await mint(SITE_ID, ['read:stats']);
  const admins = await mint(SITE_ID, ['admin']);
  // The other site's key is minted by the owner standing in its team for a
  // moment, and the owner is taken out again before the walk.
  await store.setTeamMember(OTHER_TEAM, { userId: ownerId, role: 'owner', identity: true });
  const elsewhere = await mint(OTHER_SITE, ['read:stats', 'read:identity', 'write:events', 'admin']);
  await store.changeTeamMember(OTHER_TEAM, ownerId, null);

  return {
    app,
    owner,
    registered,
    callers: [
      { name: 'nobody', headers: {}, principal: null, scopes: null, ownsTeam: false, ownsAnyTeam: false },
      session('a viewer of the team', viewer, 'viewer'),
      session('an editor of the team', editor, 'editor'),
      session('an owner of the team', owner, 'owner'),
      { ...session('an owner of another team', stranger, null), ownsAnyTeam: true },
      key('a key holding only read:stats', reads, ['read:stats']),
      key('a key holding only admin', admins, ['admin']),
      key('a key of another site', elsewhere, null),
    ],
  };
}

describe('the paid routes, with a licence', () => {
  let here: Install;

  beforeAll(async () => {
    here = await install(licensedExtension());
  });

  afterAll(async () => {
    await here.app.close();
  });

  it('lists every route the process registered between the two tables, and no other', () => {
    expect(compareRoutes(here.registered, [...CORE_ROUTES, ...EE_ROUTES])).toEqual({
      unlisted: [],
      unregistered: [],
    });
    const keys = EE_ROUTES.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Every paid row names its feature: a row without one would never be
    // asked for a licence by the walk below.
    expect(EE_ROUTES.filter((rule) => rule.feature === undefined)).toEqual([]);
  });

  it('holds every paid route to its row for every kind of caller', async () => {
    expect(
      await walkRouteTable({
        app: here.app,
        origin: '',
        rules: EE_ROUTES,
        callers: here.callers,
        params: { siteId: SITE_ID, teamId: TEAM_ID },
      }),
    ).toEqual([]);
  });
});

// A paid route that changes something is held to the rule every such route
// is held to: with a session, only from this dashboard (the core's
// plugins/auth.ts). The paid routes share the core's hooks today, so this
// passes because those hooks do; it is here for the route that arrives with a
// hook of its own, which this walk is what notices.
describe('the paid routes, asked from somewhere that is not this dashboard', () => {
  let here: Install;

  beforeAll(async () => {
    here = await install(licensedExtension());
  });

  afterAll(async () => {
    await here.app.close();
  });

  it('refuse a change made with a session from a neighbour, from a stranger, and as anything but JSON', async () => {
    const writes = EE_ROUTES.filter((rule) => rule.method !== 'GET');
    expect(writes.length).toBeGreaterThan(5);
    expect(
      await walkCrossSite({
        app: here.app,
        rules: EE_ROUTES,
        params: { siteId: SITE_ID, teamId: TEAM_ID },
        session: { cookie: here.owner },
      }),
    ).toEqual([]);
  });

  it('name no route that is entered from another application', () => {
    // Held the way the core's list is: adding a row here is a decision, and
    // this is the line that has to change with it.
    expect(EE_ROUTES.filter((rule) => rule.crossSite === true).map(routeKey)).toEqual([]);
  });
});

describe('the paid routes, with no licence', () => {
  let here: Install;

  beforeAll(async () => {
    here = await install(buildExtension({ raw: undefined, publicKeys: [] }));
  });

  afterAll(async () => {
    await here.app.close();
  });

  it('refuses for the scope first and for the licence second, on every one', async () => {
    expect(
      await walkRouteTable({
        app: here.app,
        origin: '',
        rules: EE_ROUTES,
        callers: here.callers,
        params: { siteId: SITE_ID, teamId: TEAM_ID },
        licensed: false,
      }),
    ).toEqual([]);
  });

  it('would notice a paid route whose licence hook came off', async () => {
    // The core's own site route is what a paid route with no licence hook
    // looks like: said to be paid here, it lets in everybody the scope lets in.
    const disagreements = await walkRouteTable({
      app: here.app,
      origin: '',
      rules: [
        {
          method: 'GET',
          url: '/api/sites/:siteId/goals',
          needs: { kind: 'site', scope: 'read:stats' },
          feature: 'anything',
        },
      ],
      callers: here.callers,
      params: { siteId: SITE_ID, teamId: TEAM_ID },
      licensed: false,
    });
    expect(disagreements).toContain(
      'GET /api/sites/:siteId/goals as a viewer of the team: should be refused 403 LICENSE_REQUIRED, answered 200',
    );
  });
});
