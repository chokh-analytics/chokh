import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { ssoBodySchema, ssoQuerySchema } from '../schemas/accounts.schema.js';
import { SESSION_COOKIE } from '../services/auth.service.js';
import { exchangeSsoToken } from '../services/sso.service.js';
import { publicUser } from './accounts.controller.js';

// Two ways in, one exchange.
//
// POST is for a program: an admin panel's backend mints a token, posts it here and
// gets the cookie back to hand on. GET is for a person: a link in that admin panel
// is a top level navigation, this sets the cookie and redirects to the dashboard,
// and they are simply already signed in.
//
// The GET form puts the token in a URL, which means it can end up in a browser's
// history, a proxy log and a Referer header. That is why the token lives five
// minutes and why its jti is single use: by the time it has been written down
// anywhere it is already worth nothing. Said again in the server README, because
// somebody will be tempted to raise SSO_MAX_AGE_SECONDS.

function ssoDeps(deps: ApiDeps) {
  return {
    store: deps.store,
    once: deps.once,
    secret: deps.sso.secret,
    maxAgeSeconds: deps.sso.maxAgeSeconds,
    now: deps.now,
  };
}

function setSession(deps: ApiDeps, reply: FastifyReply, userId: string): void {
  const issued = deps.session.issue(userId, deps.now());
  reply.setCookie(SESSION_COOKIE, issued.value, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.cookie.secure,
    maxAge: Math.floor(deps.session.ttlMs / 1000),
  });
}

export function createSsoPostController(deps: ApiDeps) {
  return async function ssoPostController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = ssoBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'A token is required', parsed.error.issues));
    }
    const result = await exchangeSsoToken(ssoDeps(deps), parsed.data.token);
    if (!result.ok) {
      request.log.warn({ code: result.code }, 'sso exchange refused');
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    setSession(deps, reply, result.user.id);
    return reply.send(ok({ user: publicUser(result.user) }));
  };
}

export function createSsoGetController(deps: ApiDeps) {
  return async function ssoGetController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = ssoQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_QUERY', 'A token is required', parsed.error.issues));
    }
    const result = await exchangeSsoToken(ssoDeps(deps), parsed.data.token);
    if (!result.ok) {
      request.log.warn({ code: result.code }, 'sso exchange refused');
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    setSession(deps, reply, result.user.id);
    // 303, so the browser follows with a GET whatever it arrived with, and the
    // token is not in the address bar of the page that loads. next is validated to
    // be a path of this dashboard: an open redirect behind a sign-in hop is how a
    // trusted link becomes a phishing link.
    return reply.code(303).redirect(parsed.data.next ?? '/', 303);
  };
}
