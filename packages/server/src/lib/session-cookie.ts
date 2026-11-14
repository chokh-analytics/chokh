import type { FastifyReply, FastifyRequest } from 'fastify';

import { SESSION_COOKIE } from '../services/auth.service.js';
import type { StoredUser } from '../store/AnalyticsStore.js';
import type { ApiDeps } from './api-deps.js';

// The one place a dashboard session starts.
//
// Signing in with a password and arriving through the SSO exchange both end
// here, so the cookie is set one way: under the count of how many times the
// account's sessions have been ended, as it is at this moment. A session
// started for somebody whose role was lowered a moment ago is therefore
// started after the count moved, and is the one cookie of theirs that lives.

export function startSession(
  deps: Pick<ApiDeps, 'session' | 'cookie' | 'now'>,
  reply: FastifyReply,
  user: Pick<StoredUser, 'id' | 'sessionEpoch'>,
): void {
  const issued = deps.session.issue(user.id, deps.now(), user.sessionEpoch ?? 0);
  void reply.setCookie(SESSION_COOKIE, issued.value, {
    path: '/',
    // Not readable by script, so an XSS in a dashboard widget cannot steal it.
    httpOnly: true,
    // Lax and not Strict: the SSO exchange is a top level navigation from
    // another application, and Strict would drop the cookie on the very
    // redirect that sets it. Lax still refuses it on a request from another
    // site; a request from another origin of the same site is what the check
    // in plugins/auth.ts is for.
    sameSite: 'lax',
    secure: deps.cookie.secure,
    maxAge: Math.floor(deps.session.ttlMs / 1000),
  });
}

// A cookie of an extension's own, with the attributes every cookie here has:
// not readable by a script, sent on a navigation back from another site and
// on nothing else that crosses one, and only over TLS where the install is
// served over it. The extension chooses the name, the path it is sent to and
// how long it lasts; it does not get to choose to be looser than that.
export function writeCookie(
  deps: Pick<ApiDeps, 'cookie'>,
  reply: FastifyReply,
  name: string,
  value: string,
  options: { path: string; maxAgeSeconds: number },
): void {
  void reply.setCookie(name, value, {
    path: options.path,
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.cookie.secure,
    maxAge: options.maxAgeSeconds,
  });
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  return request.cookies[name];
}

export function clearCookie(reply: FastifyReply, name: string, path: string): void {
  void reply.clearCookie(name, { path });
}
