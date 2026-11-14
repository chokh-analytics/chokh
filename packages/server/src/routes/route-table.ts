import type { FastifyInstance } from 'fastify';

import type { Scope } from '../store/AnalyticsStore.js';

// Every route of the server and the one thing each asks of a caller, as data.
//
// api.routes.ts is where a route gets its hook. This is the same statement
// made a second time, on purpose, in a form a test can walk: the test collects
// every route the framework registered and fails if this list and that one
// differ in either direction, then calls every route as every kind of caller
// and holds each answer to what the row here says. So a route cannot be added
// without a row, a row cannot outlive its route, and a hook cannot come off a
// route without a caller who should have been refused getting through.
//
// It ships with the server rather than living beside the tests because
// packages/ee holds its own routes to the same walk, and an extension is
// written against what this package exports.

export type RouteNeed =
  // Anybody, with or without credentials. Signing in, the collector, health.
  | { kind: 'public' }
  // Whoever holds the share link in the path, and nothing else is consulted.
  | { kind: 'share' }
  // Somebody: a session or a key, whatever it may do.
  | { kind: 'principal' }
  // A scope on the site in the path. With `person`, held by somebody signed
  // in and not by a key: a key that holds the scope is refused for being one.
  | { kind: 'site'; scope: Scope; person?: true }
  // A person, signed in, who is an owner of the team the request names (in
  // its path or in its body). Never a key.
  | { kind: 'teamOwner' }
  // The first account of an install registers itself; every one after it is
  // created by a person who owns a team.
  | { kind: 'register' };

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// What a probe may put in a path or a body: the ids the walk was given, and a
// number no other request of the walk has, for anything that has to be unique.
export interface ProbeContext {
  params: Readonly<Record<string, string>>;
  serial: number;
}

export interface RouteRule {
  method: RouteMethod;
  url: string;
  needs: RouteNeed;
  // A body that validates, for a route whose controller reads its body before
  // it asks who is calling: without one every caller is answered 400 and the
  // walk would prove nothing about the check behind it.
  body?: (context: ProbeContext) => unknown;
  // A response that never ends (server sent events). The walk opens it over a
  // real socket and closes it once the status has arrived.
  stream?: true;
  // The paid feature a route of packages/ee belongs to. With no licence a
  // caller who passed the scope check is refused for the licence instead, and
  // one who did not is refused for the scope first.
  feature?: string;
  // Entered from another application by design: a browser arrives here from
  // another origin carrying a token that application signed, and that is the
  // route working. Every other route refuses a change that a session makes
  // from anywhere but this dashboard (plugins/auth.ts); these read no session
  // at all, so there is nothing for that rule to protect on them. The list is
  // short on purpose and a test holds it: adding a row here is a decision.
  crossSite?: true;
}

const read: RouteNeed = { kind: 'site', scope: 'read:stats' };
const identity: RouteNeed = { kind: 'site', scope: 'read:identity' };
const write: RouteNeed = { kind: 'site', scope: 'write:events' };
const admin: RouteNeed = { kind: 'site', scope: 'admin' };
const adminPerson: RouteNeed = { kind: 'site', scope: 'admin', person: true };
const teamOwner: RouteNeed = { kind: 'teamOwner' };
const open: RouteNeed = { kind: 'public' };
const anybody: RouteNeed = { kind: 'principal' };
const shared: RouteNeed = { kind: 'share' };

function rule(
  method: RouteMethod,
  url: string,
  needs: RouteNeed,
  extra: Pick<RouteRule, 'body' | 'stream' | 'crossSite'> = {},
): RouteRule {
  return { method, url, needs, ...extra };
}

const SITE = '/api/sites/:siteId';
const SHARE = '/api/share/:token';

// The MIT core's routes. packages/ee declares its own beside its own routes.
export const CORE_ROUTES: readonly RouteRule[] = [
  rule('GET', '/health', open),
  rule('POST', '/api/collect', open),

  // Signing in.
  rule('POST', '/api/auth/register', { kind: 'register' }, {
    body: ({ serial }) => ({
      email: `probe-${serial}@route-table.test`,
      password: 'a-password-long-enough',
    }),
  }),
  rule('POST', '/api/auth/login', open),
  rule('POST', '/api/auth/logout', anybody),
  rule('GET', '/api/me', anybody),
  rule('POST', '/api/sso', open, { crossSite: true }),
  rule('GET', '/api/sso', open, { crossSite: true }),
  rule('GET', '/api/license', anybody),

  // Teams: read and changed by a person who owns the team in the path.
  rule('GET', '/api/teams/:teamId/members', teamOwner),
  rule('PUT', '/api/teams/:teamId/members/:userId', teamOwner, {
    body: () => ({ role: 'viewer', identity: false }),
  }),
  rule('DELETE', '/api/teams/:teamId/members/:userId', teamOwner),
  rule('PATCH', '/api/teams/:teamId', teamOwner, { body: ({ params }) => ({ name: params['teamId'] }) }),
  rule('GET', '/api/teams/:teamId/invitations', teamOwner),
  rule('POST', '/api/teams/:teamId/invitations', teamOwner),
  rule('DELETE', '/api/teams/:teamId/invitations/:invitationId', teamOwner),

  // What somebody holding an invitation link uses: no session, the token in
  // the body, limited by address.
  rule('POST', '/api/invitations/lookup', open),
  rule('POST', '/api/invitations/accept', open),

  // Sites.
  rule('GET', '/api/sites', anybody),
  rule('POST', '/api/sites', teamOwner, {
    body: ({ params, serial }) => ({
      name: `Probe ${serial}`,
      domains: [`probe-${serial}.route-table.test`],
      teamId: params['teamId'],
    }),
  }),
  rule('GET', SITE, read),
  rule('PATCH', SITE, admin),
  rule('POST', `${SITE}/identify-secret/rotate`, admin),

  // Roles on one site: admin, and a person.
  rule('GET', `${SITE}/members`, adminPerson),
  rule('PUT', `${SITE}/members/:userId`, adminPerson, {
    body: () => ({ role: 'viewer', identity: false }),
  }),
  rule('DELETE', `${SITE}/members/:userId`, adminPerson),
  rule('GET', `${SITE}/invitations`, adminPerson),
  rule('POST', `${SITE}/invitations`, adminPerson),
  rule('DELETE', `${SITE}/invitations/:invitationId`, adminPerson),

  // The public share: the owner's two routes, then the reader's.
  rule('PUT', `${SITE}/share`, admin),
  rule('DELETE', `${SITE}/share`, admin),
  rule('GET', SHARE, open),
  rule('POST', `${SHARE}/unlock`, open),
  rule('GET', `${SHARE}/stats/aggregate`, shared),
  rule('GET', `${SHARE}/stats/timeseries`, shared),
  rule('GET', `${SHARE}/stats/breakdown`, shared),
  rule('GET', `${SHARE}/stats/goals`, shared),
  rule('GET', `${SHARE}/annotations`, shared),
  rule('GET', `${SHARE}/widget.svg`, shared),

  // Keys.
  rule('GET', `${SITE}/keys`, admin),
  rule('POST', `${SITE}/keys`, admin),
  rule('DELETE', `${SITE}/keys/:keyId`, admin),

  // The reports.
  rule('GET', `${SITE}/stats/aggregate`, read),
  rule('GET', `${SITE}/stats/timeseries`, read),
  rule('GET', `${SITE}/stats/breakdown`, read),
  rule('GET', `${SITE}/stats/engagement`, read),
  rule('GET', `${SITE}/export.csv`, read),
  rule('GET', `${SITE}/stats/events`, read),
  rule('GET', `${SITE}/stats/properties`, read),
  rule('GET', `${SITE}/stats/goals`, read),

  // Goals, segments, annotations, funnels.
  rule('GET', `${SITE}/goals`, read),
  rule('POST', `${SITE}/goals`, admin),
  rule('DELETE', `${SITE}/goals/:goalId`, admin),
  rule('GET', `${SITE}/segments`, read),
  rule('POST', `${SITE}/segments`, admin),
  rule('DELETE', `${SITE}/segments/:segmentId`, admin),
  rule('GET', `${SITE}/annotations`, read),
  rule('POST', `${SITE}/annotations`, write),
  rule('DELETE', `${SITE}/annotations/:annotationId`, write),
  rule('GET', `${SITE}/funnels`, read),
  rule('POST', `${SITE}/funnels`, admin),
  rule('DELETE', `${SITE}/funnels/:funnelId`, admin),
  rule('GET', `${SITE}/stats/funnel`, read),
  rule('GET', `${SITE}/stats/journeys`, read),

  // Retention and health.
  rule('GET', `${SITE}/stats/cohorts`, read),
  rule('GET', `${SITE}/stats/activity`, read),
  rule('GET', `${SITE}/stats/attribution`, read),
  rule('GET', `${SITE}/stats/power-users`, read),
  rule('GET', `${SITE}/stats/vitals`, read),
  rule('GET', `${SITE}/stats/errors`, read),
  rule('GET', `${SITE}/stats/coverage`, read),

  // Who is here now.
  rule('GET', `${SITE}/realtime`, read),
  rule('GET', `${SITE}/realtime/stream`, read, { stream: true }),

  // People. The two user routes cannot be reached at all without identity.
  rule('GET', `${SITE}/people`, read),
  rule('GET', `${SITE}/visitors/:visitorId`, read),
  rule('GET', `${SITE}/users/:userId`, identity),
  rule('GET', `${SITE}/users/:userId/presence`, identity),

  // What a backend sends.
  rule('POST', `${SITE}/events`, write),
];

export function routeKey(route: { method: string; url: string }): string {
  return `${route.method.toUpperCase()} ${route.url}`;
}

// The static hosting of the built dashboard: a wildcard and the index, there
// when a build is on disk and absent when it is not. Files, not an API, and
// the same for everybody, so they are left out of the comparison rather than
// listed as two rows that exist on some machines only.
const STATIC_URLS: ReadonlySet<string> = new Set(['/', '/*']);

// What the framework registered against what a table says, both ways. HEAD is
// left out: the framework adds one for every GET and it runs the same hooks.
export function compareRoutes(
  registered: readonly { method: string; url: string }[],
  rules: readonly RouteRule[],
): { unlisted: string[]; unregistered: string[] } {
  const actual = new Set(
    registered
      .filter((route) => route.method.toUpperCase() !== 'HEAD' && !STATIC_URLS.has(route.url))
      .map(routeKey),
  );
  const declared = new Set(rules.map(routeKey));
  return {
    unlisted: [...actual].filter((key) => !declared.has(key)).sort(),
    unregistered: [...declared].filter((key) => !actual.has(key)).sort(),
  };
}

// One kind of caller, described by what is true of them and not by what any
// route is expected to answer: the expectation is worked out from this and
// the row, so the walk cannot agree with a route by copying it.
export interface RouteCaller {
  name: string;
  headers: Record<string, string>;
  // Null for nobody, and for credentials nobody issued.
  principal: 'session' | 'key' | null;
  // What they may do on the site the walk probes, or null when they have no
  // grant on it at all.
  scopes: readonly Scope[] | null;
  // Whether they own the team the walk probes, and whether they own any.
  ownsTeam: boolean;
  ownsAnyTeam: boolean;
}

export type Expected = 'allowed' | { status: number; code: string };

const UNAUTHENTICATED: Expected = { status: 401, code: 'UNAUTHENTICATED' };
const FORBIDDEN: Expected = { status: 403, code: 'FORBIDDEN' };

// What one row asks of one caller. `licensed` is whether the install may run
// the row's paid feature; a core row has none and is never refused for it.
export function expectedOf(rule: RouteRule, caller: RouteCaller, licensed = true): Expected {
  const afterScope: Expected =
    rule.feature !== undefined && !licensed ? { status: 403, code: 'LICENSE_REQUIRED' } : 'allowed';
  switch (rule.needs.kind) {
    case 'public':
    case 'share':
      return 'allowed';
    case 'principal':
      return caller.principal === null ? UNAUTHENTICATED : afterScope;
    case 'site':
      if (caller.principal === null) return UNAUTHENTICATED;
      if (caller.scopes === null) return { status: 403, code: 'SITE_FORBIDDEN' };
      if (!caller.scopes.includes(rule.needs.scope)) return { status: 403, code: 'SCOPE_REQUIRED' };
      if (rule.needs.person === true && caller.principal !== 'session') return FORBIDDEN;
      return afterScope;
    case 'teamOwner':
      if (caller.principal === null) return UNAUTHENTICATED;
      return caller.principal === 'session' && caller.ownsTeam ? afterScope : FORBIDDEN;
    case 'register':
      // No hook answers 401 here: the route has to hear from nobody, because
      // the first account has no credentials to present.
      return caller.principal === 'session' && caller.ownsAnyTeam ? 'allowed' : FORBIDDEN;
  }
}

export interface RouteWalk {
  app: FastifyInstance;
  // Where the app is listening, for the rows that stream.
  origin: string;
  rules: readonly RouteRule[];
  callers: readonly RouteCaller[];
  // What goes in a path: siteId, teamId, token and anything else a row names.
  // A parameter not given here is filled with an id nothing answers to.
  params: Record<string, string>;
  licensed?: boolean;
  // Run before every request, with the row it is for, to put back anything
  // the request before it changed.
  before?: (rule: RouteRule) => Promise<void> | void;
}

interface Answer {
  status: number;
  code: string | undefined;
  failed: boolean;
}

function pathOf(url: string, params: Readonly<Record<string, string>>): string {
  return url.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
    encodeURIComponent(params[name] ?? 'x_nothing'),
  );
}

function codeOf(body: string): { code: string | undefined; failed: boolean } {
  try {
    const parsed = JSON.parse(body) as { success?: boolean; error?: { code?: string } };
    return { code: parsed.error?.code, failed: parsed.success === false };
  } catch {
    return { code: undefined, failed: false };
  }
}

async function ask(
  walk: RouteWalk,
  rule: RouteRule,
  caller: RouteCaller,
  serial: number,
): Promise<Answer> {
  const path = pathOf(rule.url, walk.params);
  if (rule.stream === true) {
    // A real socket: an injected request to a response that never ends never
    // returns. The status is in the head, and the body is read only when it is
    // a refusal, which ends.
    const stop = new AbortController();
    try {
      const response = await fetch(`${walk.origin}${path}`, {
        method: rule.method,
        headers: caller.headers,
        signal: stop.signal,
      });
      const refused = response.headers.get('content-type')?.includes('application/json') ?? false;
      const parsed = refused ? codeOf(await response.text()) : { code: undefined, failed: false };
      return { status: response.status, ...parsed };
    } finally {
      stop.abort();
    }
  }
  const hasBody = rule.method !== 'GET' && rule.method !== 'DELETE';
  const response = await walk.app.inject({
    method: rule.method,
    url: path,
    headers: caller.headers,
    ...(hasBody ? { payload: (rule.body?.({ params: walk.params, serial }) ?? {}) as object } : {}),
  });
  return { status: response.statusCode, ...codeOf(response.body) };
}

// Call every row as every caller and answer with every disagreement, as
// sentences. An empty list is the proof; a test asserts it is empty and prints
// it when it is not.
//
// "Allowed" is held strictly: the answer may be anything the route gives a
// caller it let in (a 200, a 400 for the empty probe, a 404 for an id nothing
// answers to), and may not be a 401, a 403, a 429 or a fault. So a route that
// lets somebody past its hook and refuses them further in is a disagreement
// too, and has to be said in the table.
export async function walkRouteTable(walk: RouteWalk): Promise<string[]> {
  const disagreements: string[] = [];
  let serial = 0;
  for (const rule of walk.rules) {
    for (const caller of walk.callers) {
      serial += 1;
      await walk.before?.(rule);
      const expected = expectedOf(rule, caller, walk.licensed ?? true);
      const answer = await ask(walk, rule, caller, serial);
      const said = `${answer.status}${answer.code === undefined ? '' : ` ${answer.code}`}`;
      if (expected === 'allowed') {
        if (answer.status === 401 || answer.status === 403 || answer.status === 429 || answer.status >= 500) {
          disagreements.push(`${routeKey(rule)} as ${caller.name}: should be let in, answered ${said}`);
        }
      } else if (
        answer.status !== expected.status ||
        answer.code !== expected.code ||
        !answer.failed
      ) {
        disagreements.push(
          `${routeKey(rule)} as ${caller.name}: should be refused ${expected.status} ${expected.code}, answered ${said}`,
        );
      }
    }
  }
  return disagreements;
}

export interface CrossSiteWalk {
  app: FastifyInstance;
  rules: readonly RouteRule[];
  params: Record<string, string>;
  // The headers of somebody signed in who may do everything the rows ask:
  // the point is that even they are refused from the wrong place.
  session: Record<string, string>;
}

function answeredWith(response: { statusCode: number; body: string }): string {
  return `${response.statusCode} ${codeOf(response.body).code ?? ''}`.trim();
}

// Ask every row a session can change something through the way another origin
// would ask it, and answer with every row that did not refuse (plugins/auth.ts
// has the rule). From a neighbour (same-site) and from a stranger
// (cross-site), each has to be 403 CROSS_SITE_REQUEST; and a POST that is not
// JSON, or that has no body and no word from the browser that it is same
// origin, has to be 415 JSON_REQUIRED.
//
// The core's routes share their hooks, so this mostly proves the hooks. It is
// here for the route that arrives with a hook of its own: an extension's
// routes are walked with it too.
export async function walkCrossSite(walk: CrossSiteWalk): Promise<string[]> {
  const disagreements: string[] = [];
  const ask = (rule: RouteRule, headers: Record<string, string>, body?: string) =>
    walk.app.inject({
      method: rule.method,
      url: pathOf(rule.url, walk.params),
      headers: { ...walk.session, ...headers },
      ...(body === undefined ? {} : { payload: body }),
    });
  for (const rule of walk.rules) {
    if (rule.crossSite === true) {
      if (rule.needs.kind !== 'public') {
        disagreements.push(`${routeKey(rule)}: marked as entered from another application, and reads a session`);
      }
      continue;
    }
    if (rule.method === 'GET' || rule.needs.kind === 'public' || rule.needs.kind === 'share') {
      continue;
    }
    for (const from of ['same-site', 'cross-site']) {
      const response = await ask(rule, { 'sec-fetch-site': from, 'content-type': 'application/json' }, '{}');
      if (answeredWith(response) !== '403 CROSS_SITE_REQUEST') {
        disagreements.push(`${routeKey(rule)} from ${from}: answered ${answeredWith(response)}`);
      }
    }
    if (rule.method !== 'POST') {
      continue;
    }
    const forms: [string | undefined, string | undefined][] = [
      ['application/x-www-form-urlencoded', undefined],
      ['text/plain', undefined],
      ['multipart/form-data; boundary=x', 'same-origin'],
      // No body and no type, and nothing from the browser to say where from.
      [undefined, undefined],
    ];
    for (const [type, fetchSite] of forms) {
      const response = await ask(
        rule,
        {
          ...(type === undefined ? {} : { 'content-type': type }),
          ...(fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite }),
        },
        type === undefined ? undefined : '{}',
      );
      if (answeredWith(response) !== '415 JSON_REQUIRED') {
        disagreements.push(
          `${routeKey(rule)} as ${type ?? 'nothing at all'}: answered ${answeredWith(response)}`,
        );
      }
    }
  }
  return disagreements;
}
