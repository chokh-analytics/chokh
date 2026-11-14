import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopesForRole } from '../lib/scopes.js';
import { SCOPES, type Role, type Scope } from '../store/AnalyticsStore.js';
import { NOW, SITE_ID, TEAM_ID, createHarness, testSite, type Harness } from './api.test-utils.js';
import {
  CORE_ROUTES,
  compareRoutes,
  expectedOf,
  routeKey,
  walkRouteTable,
  type RouteCaller,
  type RouteRule,
} from './route-table.js';

// Every route against every kind of caller.
//
// The per-route tests in this directory each prove their own route. What none
// of them can notice is a route nobody wrote a test for, or a hook taken off
// one whose test only ever called it as the owner. This file is the other
// half: the list of routes is the framework's own, the list of callers is
// everybody who could be asking, and what each should be told is worked out
// from the route table and from what is true of the caller, never copied from
// the route.

const OTHER_SITE = 's_elsewhere';
const OTHER_TEAM = 't_elsewhere';
const SHARE_TOKEN = 'share_route_table_0123456789';

let harness: Harness;
let origin: string;
let callers: RouteCaller[];
let targetId: string;
const registered: { method: string; url: string }[] = [];
let at = NOW;

function session(name: string, cookie: string, role: Role | null, identity = false): RouteCaller {
  return {
    name,
    headers: { cookie },
    principal: 'session',
    scopes: role === null ? null : [...scopesForRole(role, identity)],
    ownsTeam: role === 'owner',
    ownsAnyTeam: role === 'owner',
  };
}

function key(name: string, authorization: string, scopes: readonly Scope[] | null): RouteCaller {
  return {
    name,
    headers: { authorization },
    principal: 'key',
    scopes,
    ownsTeam: false,
    ownsAnyTeam: false,
  };
}

beforeAll(async () => {
  harness = await createHarness({
    sites: [
      testSite(),
      testSite({ id: OTHER_SITE, domains: ['elsewhere.example'], teamId: OTHER_TEAM }),
    ],
    onRoute: (route) => registered.push(route),
  });
  await harness.store.createTeam({ id: OTHER_TEAM, name: 'Elsewhere', members: [] });

  // Each account is a registration and a sign-in, and the two share the
  // limit on attempts from one address, so the clock moves on between them.
  const account: Harness['account'] = (input) => {
    at += 61_000;
    harness.setNow(at);
    return harness.account(input);
  };
  const viewer = await account({ email: 'viewer@test.example', role: 'viewer' });
  const reader = await account({ email: 'reader@test.example', role: 'viewer', identity: true });
  const editor = await account({ email: 'editor@test.example', role: 'editor' });
  const stranger = await account({
    email: 'stranger@test.example',
    role: 'owner',
    teamId: OTHER_TEAM,
  });
  // Somebody the member route can be pointed at who is not one of the callers,
  // so a caller's own role is never what a probe changes.
  const target = await account({ email: 'target@test.example', role: 'viewer', teamId: OTHER_TEAM });
  targetId = target.userId;

  callers = [
    { name: 'nobody', headers: {}, principal: null, scopes: null, ownsTeam: false, ownsAnyTeam: false },
    {
      name: 'a key nobody issued',
      headers: { authorization: 'Bearer chk_this_key_was_never_minted' },
      principal: null,
      scopes: null,
      ownsTeam: false,
      ownsAnyTeam: false,
    },
    session('a viewer of the team', viewer.cookie, 'viewer'),
    session('a viewer of the team with the identity flag', reader.cookie, 'viewer', true),
    session('an editor of the team', editor.cookie, 'editor'),
    session('an owner of the team', harness.owner.cookie, 'owner'),
    // An owner, but of a team that does not own this site: no grant here, and
    // still somebody who may create an account.
    { ...session('an owner of another team', stranger.cookie, null), ownsAnyTeam: true },
    ...(await Promise.all(
      SCOPES.map(async (scope) => key(`a key holding only ${scope}`, await harness.key([scope]), [scope])),
    )),
    key('a key of another site', await harness.key([...SCOPES], OTHER_SITE), null),
  ];

  await harness.app.listen({ port: 0, host: '127.0.0.1' });
  origin = `http://127.0.0.1:${(harness.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await harness.close();
});

// Put back what a probe may have changed. The owner's PUT and DELETE of the
// share are real, so the link is restored each time. And for a row that is
// limited by address (signing in, a share's reads), move the clock on a minute
// so no request meets the limit the ones before it used up; only for those,
// because a minute for every request of the walk would outlast the sessions
// the callers hold.
async function before(rule: RouteRule): Promise<void> {
  if (rule.needs.kind === 'public' || rule.needs.kind === 'share' || rule.needs.kind === 'register') {
    at += 61_000;
    harness.setNow(at);
  }
  await harness.store.updateSite(SITE_ID, {
    share: { token: SHARE_TOKEN, createdBy: harness.owner.userId, createdAt: NOW },
  });
}

function walk(rules: readonly RouteRule[]): Promise<string[]> {
  return walkRouteTable({
    app: harness.app,
    origin,
    rules,
    callers,
    params: { siteId: SITE_ID, teamId: TEAM_ID, token: SHARE_TOKEN, userId: targetId },
    before,
  });
}

describe('the route table', () => {
  it('lists every route the server registered, and no route that is not there', () => {
    expect(registered.length).toBeGreaterThan(60);
    expect(compareRoutes(registered, CORE_ROUTES)).toEqual({ unlisted: [], unregistered: [] });
    // And no row twice: a second row for a route would be walked and agree
    // with itself whatever the first one said.
    const keys = CORE_ROUTES.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('holds every route to its row for every kind of caller', async () => {
    const disagreements = await walk(CORE_ROUTES);
    expect(disagreements).toEqual([]);
  }, 120_000);

  it('says what it expects from what is true of a caller, for each kind of row', () => {
    const [nobody, , viewer, reader, editor, owner, stranger] = callers as [
      RouteCaller,
      RouteCaller,
      RouteCaller,
      RouteCaller,
      RouteCaller,
      RouteCaller,
      RouteCaller,
    ];
    const row = (url: string): RouteRule => {
      const found = CORE_ROUTES.find((rule) => routeKey(rule) === url);
      if (found === undefined) throw new Error(`no row for ${url}`);
      return found;
    };
    const people = row('GET /api/sites/:siteId/users/:userId');
    expect(expectedOf(people, nobody)).toEqual({ status: 401, code: 'UNAUTHENTICATED' });
    expect(expectedOf(people, stranger)).toEqual({ status: 403, code: 'SITE_FORBIDDEN' });
    expect(expectedOf(people, viewer)).toEqual({ status: 403, code: 'SCOPE_REQUIRED' });
    expect(expectedOf(people, editor)).toEqual({ status: 403, code: 'SCOPE_REQUIRED' });
    expect(expectedOf(people, reader)).toBe('allowed');
    expect(expectedOf(people, owner)).toBe('allowed');
    const members = row('PUT /api/teams/:teamId/members/:userId');
    expect(expectedOf(members, nobody)).toEqual({ status: 401, code: 'UNAUTHENTICATED' });
    expect(expectedOf(members, editor)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(expectedOf(members, stranger)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(expectedOf(members, owner)).toBe('allowed');
    const register = row('POST /api/auth/register');
    expect(expectedOf(register, nobody)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(expectedOf(register, stranger)).toBe('allowed');
    // A paid row on an install with no licence: the scope first, then the key.
    const paid: RouteRule = { ...row('GET /api/sites/:siteId'), feature: 'anything' };
    expect(expectedOf(paid, nobody, false)).toEqual({ status: 401, code: 'UNAUTHENTICATED' });
    expect(expectedOf(paid, stranger, false)).toEqual({ status: 403, code: 'SITE_FORBIDDEN' });
    expect(expectedOf(paid, viewer, false)).toEqual({ status: 403, code: 'LICENSE_REQUIRED' });
    expect(expectedOf(paid, viewer, true)).toBe('allowed');
  });

  // The walk is only worth what it notices. Two rows said wrongly on purpose:
  // a route that needs admin declared as open to a reader, and a route open to
  // a reader declared as needing admin. Each has to come back as a list of
  // disagreements naming the callers on the wrong side of it.
  it('notices a row that says less than the route asks, and one that says more', async () => {
    const tooLittle = await walk([
      { method: 'GET', url: '/api/sites/:siteId/keys', needs: { kind: 'site', scope: 'read:stats' } },
    ]);
    expect(tooLittle).toContain(
      'GET /api/sites/:siteId/keys as a viewer of the team: should be let in, answered 403 SCOPE_REQUIRED',
    );
    expect(tooLittle).toContain(
      'GET /api/sites/:siteId/keys as a key holding only read:stats: should be let in, answered 403 SCOPE_REQUIRED',
    );
    const tooMuch = await walk([
      { method: 'GET', url: '/api/sites/:siteId/goals', needs: { kind: 'site', scope: 'admin' } },
    ]);
    expect(tooMuch).toContain(
      'GET /api/sites/:siteId/goals as a viewer of the team: should be refused 403 SCOPE_REQUIRED, answered 200',
    );
    // A row for a route with no hook at all would read the same way: every
    // caller who should have been refused is answered instead.
    const noHook = await walk([{ method: 'GET', url: '/health', needs: { kind: 'principal' } }]);
    expect(noHook).toContain('GET /health as nobody: should be refused 401 UNAUTHENTICATED, answered 200');
  }, 60_000);
});
