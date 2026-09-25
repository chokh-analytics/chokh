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

// Resolve whoever is asking, and refuse nobody. Registration needs it: the
// first account has no credentials to present and every one after it is created
// by an owner, so the route has to see both cases.
export function attachPrincipal(deps: AuthDeps): preHandlerHookHandler {
  return async function attachHook(request: FastifyRequest) {
    await attach(deps, request);
  };
}

export function requirePrincipal(deps: AuthDeps): preHandlerHookHandler {
  return async function principalHook(request: FastifyRequest, reply: FastifyReply) {
    if ((await attach(deps, request)) === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', NO_CREDENTIALS));
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
        .send(fail('SITE_FORBIDDEN', 'This account has no role in the team that owns that site'));
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
