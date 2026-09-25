import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail } from '../lib/envelope.js';
import { sharePrincipal } from '../lib/scopes.js';
import { SHARE_COOKIE } from '../services/share.service.js';

// The gate on a share's report routes (AN-RPT01).
//
// Resolves the site by the token in the path, refuses a locked share without
// its cookie, and then hands the request the same three things the scope hook
// hands it for a session or a key: the site, a principal and a grant. The
// principal holds read:stats on that one site and nothing else, so the report
// controllers serve the public page unchanged and every rule they apply
// applies here. Nothing about identity, people, realtime or events is
// registered under a share, which is what keeps a link from reading a person.

export function requireShare(
  deps: Pick<ApiDeps, 'store' | 'shareCodec' | 'now'>,
): preHandlerHookHandler {
  return async function shareHook(request: FastifyRequest, reply: FastifyReply) {
    const { token } = request.params as { token?: string };
    if (token === undefined || token === '') {
      return reply.code(400).send(fail('MISSING_SHARE', 'This route needs a share token'));
    }
    const site = await deps.store.siteByShareToken(token);
    if (site === null || site.share === undefined) {
      return reply.code(404).send(fail('UNKNOWN_SHARE', 'No share answers to that link'));
    }
    void reply.header('x-robots-tag', 'noindex');
    if (
      site.share.passwordHash !== undefined &&
      !deps.shareCodec.read(request.cookies[SHARE_COOKIE], site.share, deps.now())
    ) {
      return reply.code(401).send(fail('SHARE_LOCKED', 'This share needs its password'));
    }
    request.site = site;
    request.principal = sharePrincipal(site.id);
    request.grant = { scopes: new Set(['read:stats']) };
    return undefined;
  };
}
