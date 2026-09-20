import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { fail } from '@chokh/server';

import type { LicenseReason, LicenseState } from './state.js';

// The gate in front of every paid route.
//
// Built per route, never once and shared. A preHandler array hoisted into a
// const and reused is how every route in this workspace once got the first
// route's rate limiter, and only an HTTP probe found it; the same mistake here
// would hand every paid feature the first one's name, so a key naming alerts
// would open replay. requireLicense is a factory, it is called at each
// registration, and there is a probe over HTTP that two routes name their own
// feature.
//
// It runs after the scope hook, never before. A caller with no session or no
// role on the site is refused for that first, and is never told which paid
// feature lives at the path they guessed.

const WHY: Record<LicenseReason, string> = {
  missing: 'This install has no licence key, so this feature is not enabled',
  no_issuer: 'This build carries no licence issuer, so no key can be believed',
  malformed: 'CHOKH_LICENSE_KEY is not a Chokh licence key',
  unknown_version: 'This licence key is from a newer format than this build understands',
  bad_signature: 'This licence key was not issued for this product',
  expired: 'This licence key has expired',
  not_licensed: 'This licence key does not include this feature',
};

export function requireLicense(state: LicenseState, feature: string): preHandlerHookHandler {
  // Async even though it does no waiting: a Fastify hook that returns something
  // other than a promise and never calls done leaves the request hanging.
  return async function licenseHook(request: FastifyRequest, reply: FastifyReply) {
    const decision = state.allows(feature, Date.now());
    if (decision.ok) {
      return undefined;
    }
    const reason = decision.reason ?? 'missing';
    request.log.info({ feature, reason }, 'paid feature refused');
    // One status for every reason. A customer whose key ran out and a stranger
    // with no key meet the same door; the dashboard is where the difference is
    // explained, to somebody who is signed in.
    return reply.code(403).send(
      fail('LICENSE_REQUIRED', WHY[reason], { feature, reason }),
    );
  };
}
