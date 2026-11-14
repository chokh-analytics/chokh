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
  walkCrossSite,
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
// A second site of the same team, for somebody whose only role is on it.
const SIBLING_SITE = 's_sibling';
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
      testSite({ id: SIBLING_SITE, domains: ['sibling.example'] }),
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

  // Roles held on the site itself (AN-TEAM01). Somebody with no place in the
  // team at all, at each role; and the three ways a row on the site meets a
  // role in the team: lowering it, raising it, and deciding nothing because
  // the person owns the team.
  const outsider = async (email: string): Promise<{ cookie: string; userId: string }> => {
    const made = await account({ email, role: 'viewer', teamId: OTHER_TEAM });
    await harness.store.changeTeamMember(OTHER_TEAM, made.userId, null);
    return made;
  };
  const onSite = async (
    name: string,
    made: { cookie: string; userId: string },
    siteId: string,
    role: Role,
    identity: boolean,
    effective: Role | null,
    effectiveIdentity = identity,
  ): Promise<RouteCaller> => {
    await harness.store.setSiteMember({ siteId, userId: made.userId, role, identity });
    return {
      ...session(name, made.cookie, effective, effectiveIdentity),
      // A role on a site is not a place in the team: none of these owns it.
      ownsTeam: false,
      ownsAnyTeam: false,
    };
  };
  const siteCallers: RouteCaller[] = [
    await onSite('a viewer of the site alone', await outsider('s-viewer@test.example'), SITE_ID, 'viewer', false, 'viewer'),
    await onSite('a viewer of the site alone with the identity flag', await outsider('s-reader@test.example'), SITE_ID, 'viewer', true, 'viewer'),
    await onSite('an editor of the site alone', await outsider('s-editor@test.example'), SITE_ID, 'editor', false, 'editor'),
    await onSite('an owner of the site alone', await outsider('s-owner@test.example'), SITE_ID, 'owner', true, 'owner'),
    // An owner of the site beside this one: nothing here.
    await onSite('an owner of another site of the same team', await outsider('sibling@test.example'), SIBLING_SITE, 'owner', true, null),
    await onSite(
      'an editor of the team lowered to viewer on the site',
      await account({ email: 'lowered@test.example', role: 'editor', identity: true }),
      SITE_ID,
      'viewer',
      false,
      'viewer',
    ),
    await onSite(
      'a viewer of the team raised to owner on the site',
      await account({ email: 'raised@test.example', role: 'viewer' }),
      SITE_ID,
      'owner',
      true,
      'owner',
    ),
  ];
  // An owner of the team with a viewer's row on the site is still an owner,
  // of the site and of the team.
  const second = await account({ email: 'second-owner@test.example', role: 'owner' });
  await harness.store.setSiteMember({ siteId: SITE_ID, userId: second.userId, role: 'viewer', identity: false });
  siteCallers.push(session('an owner of the team with a viewer row on the site', second.cookie, 'owner'));

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
    ...siteCallers,
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
    expect(registered.length).toBeGreaterThan(70);
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

// A change made with a session has to come from this dashboard (AN-TEAM01,
// plugins/auth.ts). Walked over the same table: every row a session can reach
// that is not a read is asked the way a neighbouring origin would ask it, and
// has to refuse; the rows entered from another application by design are a
// list of two, held here.
describe('a change made with a session, from somewhere that is not this dashboard', () => {
  const sessionReachable = (rule: RouteRule): boolean =>
    rule.method !== 'GET' && rule.needs.kind !== 'public' && rule.needs.kind !== 'share';

  function ask(rule: RouteRule, headers: Record<string, string>, body?: string) {
    const params: Record<string, string> = {
      siteId: SITE_ID,
      teamId: TEAM_ID,
      token: SHARE_TOKEN,
      userId: targetId,
    };
    return harness.app.inject({
      method: rule.method,
      url: rule.url.replace(/:([A-Za-z]+)/g, (_match, name: string) => params[name] ?? 'x_nothing'),
      headers,
      ...(body === undefined ? {} : { payload: body }),
    });
  }

  it('names the two routes that are entered from another application, and no other', () => {
    expect(CORE_ROUTES.filter((rule) => rule.crossSite === true).map(routeKey)).toEqual([
      'POST /api/sso',
      'GET /api/sso',
    ]);
    // Neither reads a session: there is nothing on them for the rule to guard.
    expect(
      CORE_ROUTES.filter((rule) => rule.crossSite === true).every((rule) => rule.needs.kind === 'public'),
    ).toBe(true);
  });

  it('is refused on every route a session can change something through, from a neighbour and from a stranger', async () => {
    const rules = CORE_ROUTES.filter(sessionReachable);
    expect(rules.length).toBeGreaterThan(20);
    const answered: string[] = [];
    for (const rule of rules) {
      for (const from of ['same-site', 'cross-site']) {
        const response = await ask(
          rule,
          { cookie: harness.owner.cookie, 'sec-fetch-site': from, 'content-type': 'application/json' },
          '{}',
        );
        const code = (JSON.parse(response.body) as { error?: { code?: string } }).error?.code;
        if (response.statusCode !== 403 || code !== 'CROSS_SITE_REQUEST') {
          answered.push(`${routeKey(rule)} from ${from}: ${response.statusCode} ${code ?? ''}`);
        }
      }
    }
    expect(answered).toEqual([]);
  });

  it('is refused when a POST is not JSON, which is what a form sends, whatever the browser says of itself', async () => {
    const posts = CORE_ROUTES.filter((rule) => sessionReachable(rule) && rule.method === 'POST');
    expect(posts.length).toBeGreaterThan(8);
    const answered: string[] = [];
    for (const rule of posts) {
      for (const [type, origin] of [
        ['application/x-www-form-urlencoded', undefined],
        ['text/plain', undefined],
        ['multipart/form-data; boundary=x', 'same-origin'],
        // No body and no type, from a browser too old to vouch for itself or
        // from a program: not taken either.
        [undefined, undefined],
      ] as const) {
        const response = await ask(
          rule,
          {
            cookie: harness.owner.cookie,
            ...(type === undefined ? {} : { 'content-type': type }),
            ...(origin === undefined ? {} : { 'sec-fetch-site': origin }),
          },
          type === undefined ? undefined : '{}',
        );
        const code = (JSON.parse(response.body) as { error?: { code?: string } }).error?.code;
        if (response.statusCode !== 415 || code !== 'JSON_REQUIRED') {
          answered.push(`${routeKey(rule)} as ${type ?? 'nothing'}: ${response.statusCode} ${code ?? ''}`);
        }
      }
    }
    expect(answered).toEqual([]);
  });

  // The same two walks as one function, which is what an extension's routes
  // are held to (packages/ee walks its own rows with it).
  it('agrees with the walk an extension runs over its own routes', async () => {
    // A fresh minute: registration is limited by address before it looks at
    // who is asking, and the cases above have used this minute up.
    at += 61_000;
    harness.setNow(at);
    expect(
      await walkCrossSite({
        app: harness.app,
        rules: CORE_ROUTES,
        params: { siteId: SITE_ID, teamId: TEAM_ID, token: SHARE_TOKEN, userId: targetId },
        session: { cookie: harness.owner.cookie },
      }),
    ).toEqual([]);
    // And it notices: a read route said to be a write is answered, not refused.
    const noticed = await walkCrossSite({
      app: harness.app,
      rules: [{ method: 'POST', url: '/api/auth/login', needs: { kind: 'principal' } }],
      params: {},
      session: { cookie: harness.owner.cookie },
    });
    expect(noticed.length).toBe(6);
    expect(noticed[0]).toContain('POST /api/auth/login from same-site: answered');
  });

  it('is taken from this dashboard: JSON, or nothing at all when the browser vouches it is same origin', async () => {
    const rotate = CORE_ROUTES.find((rule) => rule.url.endsWith('/identify-secret/rotate')) as RouteRule;
    expect(
      (
        await ask(
          rotate,
          { cookie: harness.owner.cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' },
          '{}',
        )
      ).statusCode,
    ).toBe(200);
    // A page open across a deploy still posts with no body: taken, because the
    // browser itself says where it came from.
    expect(
      (await ask(rotate, { cookie: harness.owner.cookie, 'sec-fetch-site': 'same-origin' })).statusCode,
    ).toBe(200);
    // A program with a session, which sends no such header, sends JSON.
    expect(
      (await ask(rotate, { cookie: harness.owner.cookie, 'content-type': 'application/json' }, '{}')).statusCode,
    ).toBe(200);
  });

  it('does not touch a key, a read, or anybody with no session', async () => {
    const admin = await harness.key(['admin']);
    const rotate = CORE_ROUTES.find((rule) => rule.url.endsWith('/identify-secret/rotate')) as RouteRule;
    // A key is presented on purpose; no browser attaches one by itself.
    expect(
      (await ask(rotate, { authorization: admin, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, '{}'))
        .statusCode,
    ).toBe(200);
    // A link into the dashboard from another site is a read, and reads are let in.
    const read = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/goals`,
      headers: { cookie: harness.owner.cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(read.statusCode).toBe(200);
    // Nobody is told about their credentials before anything else.
    const nobody = await ask(rotate, { 'sec-fetch-site': 'cross-site' }, '{}');
    expect(nobody.statusCode).toBe(401);
  });
});
