import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { clientIp, type ClientIpOptions } from '../lib/client-ip.js';
import { fail } from '../lib/envelope.js';
import type { Grant, Principal } from '../lib/scopes.js';
import type { WindowCounter } from '../lib/window-counter.js';
import { resolvePrincipal, SESSION_COOKIE, type AuthDeps } from '../services/auth.service.js';
import type { Scope, Site } from '../store/AnalyticsStore.js';

// Who is asking, resolved once per request, before any handler runs.
//
// Three hooks. One says a caller has to be somebody. One says they have to be
// somebody with a given scope on the site in the path. One limits how often an
// address may try to become somebody. Every refusal is the envelope, including
// 401 and 403, because AGENTS.md rule 6 has no exceptions and a client that has to
// parse a framework's error shape for the unhappy path will get it wrong.

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    // The site named in the path, read once by the scope hook so no handler
    // reads it a second time, and what this caller may do to it.
    site: Site | null;
    grant: Grant | null;
  }
}

export function registerAuthDecorations(app: FastifyInstance): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('site', null);
  app.decorateRequest('grant', null);
}

async function attach(deps: AuthDeps, request: FastifyRequest): Promise<Principal | null> {
  if (request.principal !== null) {
    return request.principal;
  }
  const found = await resolvePrincipal(deps, {
    cookie: request.cookies[SESSION_COOKIE],
    authorization: request.headers.authorization,
  });
  request.principal = found;
  return found;
}

const NO_CREDENTIALS =
  'Sign in for a session cookie, or present an API key as a bearer token';

// A request that changes something on a person's behalf has to come from this
// dashboard (AN-TEAM01).
//
// The session cookie is SameSite=Lax, which stops another site's form from
// carrying it. It does not stop another origin of the same site: a page on a
// sibling hostname is "same site" to a browser, the cookie goes with its
// request, and this server parses a body of any content type as JSON. So the
// cookie attribute was the one thing between a signed-in owner and a form on a
// neighbouring application, and it does not cover neighbours.
//
// Two checks, for a request that carries a session and is not a read:
//
// 1. Sec-Fetch-Site, which a browser sets itself and a page cannot forge, has
//    to say same-origin, or none (somebody typed the address), or be absent (a
//    program, or a browser too old to send it). same-site and cross-site are
//    refused: a neighbour is not this dashboard.
// 2. A POST has to be JSON. A form cannot send application/json, and there is
//    no CORS here to let another origin's script send it, so this holds for
//    the browsers that never send the header above. A POST with no body and no
//    content type is taken only when the browser itself vouches it is same
//    origin: a page that was open across a deploy still signs out. PUT, PATCH
//    and DELETE need no such rule, because a browser asks permission before it
//    sends one of those to another origin and nothing here grants it.
//
// A key is not held to either: a key is presented by a program on purpose, and
// a browser never attaches one by itself. The SSO exchange is entered from
// another application by design and reads no session, so it never comes here;
// the route table names it as the exception and a test holds the list.
const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAME_ORIGIN: ReadonlySet<string> = new Set(['same-origin', 'none']);

export function crossSiteRefusal(
  request: Pick<FastifyRequest, 'method' | 'headers'>,
  principal: Principal | null,
): { status: number; code: string; message: string } | null {
  if (principal?.kind !== 'session' || READS.has(request.method.toUpperCase())) {
    return null;
  }
  const site = request.headers['sec-fetch-site'];
  const fetchSite = Array.isArray(site) ? site[0] : site;
  if (fetchSite !== undefined && !SAME_ORIGIN.has(fetchSite.toLowerCase())) {
    return {
      status: 403,
      code: 'CROSS_SITE_REQUEST',
      message: 'A change made with a session has to come from this dashboard',
    };
  }
  if (request.method.toUpperCase() === 'POST') {
    const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const length = request.headers['content-length'];
    const bodiless =
      type === '' &&
      (length === undefined || length === '0') &&
      request.headers['transfer-encoding'] === undefined;
    if (type !== 'application/json' && !(bodiless && fetchSite?.toLowerCase() === 'same-origin')) {
      return {
        status: 415,
        code: 'JSON_REQUIRED',
        message: 'A POST made with a session is sent as application/json',
      };
    }
  }
  return null;
}

// Resolve whoever is asking, and refuse nobody. Registration needs it: the
// first account has no credentials to present and every one after it is created
// by an owner, so the route has to see both cases.
export function attachPrincipal(deps: AuthDeps): preHandlerHookHandler {
  return async function attachHook(request: FastifyRequest, reply: FastifyReply) {
    const refused = crossSiteRefusal(request, await attach(deps, request));
    if (refused !== null) {
      return reply.code(refused.status).send(fail(refused.code, refused.message));
    }
    return undefined;
  };
}

export function requirePrincipal(deps: AuthDeps): preHandlerHookHandler {
  return async function principalHook(request: FastifyRequest, reply: FastifyReply) {
    const principal = await attach(deps, request);
    if (principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', NO_CREDENTIALS));
    }
    const refused = crossSiteRefusal(request, principal);
    if (refused !== null) {
      return reply.code(refused.status).send(fail(refused.code, refused.message));
    }
    return undefined;
  };
}

// For a route that is somebody's decision and not a program's: who else gets
// in. Put after the scope hook, so a key is told about its scope first and
// told this only when the scope was not the problem.
export function requirePerson(): preHandlerHookHandler {
  // Async even though it does no waiting: a Fastify hook that returns something
  // other than a promise and never calls done leaves the request hanging.
  return async function personHook(request: FastifyRequest, reply: FastifyReply) {
    if (request.principal?.kind !== 'session') {
      return reply
        .code(403)
        .send(fail('FORBIDDEN', 'This is done by a person signed in, not by a key'));
    }
    return undefined;
  };
}

// The site in the path, the caller's scopes on it, and the one scope this route
// needs.
//
// A site the caller may not read answers 403 and not 404. Which sites exist is
// not a secret worth protecting here (a site id is in the page's HTML), and
// answering 404 would mean a dashboard could not tell "no such site" from "not
// yours", which is the difference between a typo and a permissions problem.
export function requireSiteScope(deps: AuthDeps, scope: Scope): preHandlerHookHandler {
  return async function siteScopeHook(request: FastifyRequest, reply: FastifyReply) {
    const principal = await attach(deps, request);
    if (principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', NO_CREDENTIALS));
    }
    const crossSite = crossSiteRefusal(request, principal);
    if (crossSite !== null) {
      return reply.code(crossSite.status).send(fail(crossSite.code, crossSite.message));
    }
    const { siteId } = request.params as { siteId?: string };
    if (siteId === undefined) {
      return reply.code(400).send(fail('MISSING_SITE', 'This route needs a site id'));
    }
    const site = await deps.store.site(siteId);
    if (site === null) {
      return reply.code(404).send(fail('UNKNOWN_SITE', `No site answers to ${siteId}`));
    }
    const grant = principal.grantFor(site);
    if (grant === null) {
      return reply
        .code(403)
        .send(
          fail('SITE_FORBIDDEN', 'This account has no role on that site or in the team that owns it'),
        );
    }
    if (!grant.scopes.has(scope)) {
      return reply.code(403).send(fail('SCOPE_REQUIRED', `This route needs the ${scope} scope`));
    }
    request.site = site;
    request.grant = grant;
    return undefined;
  };
}

// The gate in front of signing in.
//
// Login, registration and both SSO forms are the routes where an address gets to
// guess, so they are limited per address rather than per account: limiting per
// account is how somebody locks a person out of their own dashboard by guessing at
// them. The counter is the same one the collector uses, a fixed window a minute
// wide, which is coarse and enough: this is here to stop a script, not a botnet.
export function limitAttempts(
  limit: number,
  counter: WindowCounter,
  ipOptions: ClientIpOptions,
  now: () => number,
  // The bucket's name, so a share's reads and an address's sign-in attempts
  // are two counts and not one.
  bucket = 'auth',
): preHandlerHookHandler {
  // Async even though it does no waiting: a Fastify hook that returns something
  // other than a promise and never calls done leaves the request hanging.
  return async function attemptsHook(request: FastifyRequest, reply: FastifyReply) {
    const at = now();
    const address = clientIp(
      {
        ip: request.ip,
        peer: request.socket.remoteAddress,
        header: request.headers[ipOptions.realIpHeader],
        signature: request.headers['x-chokh-forwarded-sig'],
        now: at,
      },
      ipOptions,
    );
    if (counter.hit(`${bucket}:${address}`, at) > limit) {
      return reply
        .code(429)
        .send(fail('RATE_LIMITED', 'Too many attempts from this address, wait a minute'));
    }
    return undefined;
  };
}
