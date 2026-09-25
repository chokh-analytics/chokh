import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { attempt } from '../lib/store-error.js';
import { putShareSchema, unlockShareSchema } from '../schemas/share.schema.js';
import { verifyPassword } from '../services/auth.service.js';
import { clearShare, publicShare, setShare, SHARE_COOKIE, SHARE_TTL_MS } from '../services/share.service.js';

// A site's public share (AN-RPT01): two routes for the owner on the site,
// and the public ones on the token, which the share hook in plugins/share.ts
// guards for every report route registered under it.

export function createPutShareController(deps: ApiDeps) {
  return async function putShareController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = putShareSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'The share did not validate', parsed.error.issues));
    }
    const updated = await attempt(() =>
      setShare(deps.store, site, parsed.data, principal.id, deps.now()),
    );
    if (!updated.ok) {
      return reply.code(updated.status).send(fail(updated.code, updated.message));
    }
    const share = updated.data.share;
    if (share === undefined) {
      return reply.code(500).send(fail('SHARE_MISSING', 'The share was not kept'));
    }
    return reply.send(ok({ share: publicShare(share) }));
  };
}

export function createDeleteShareController(deps: ApiDeps) {
  return async function deleteShareController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const cleared = await attempt(() => clearShare(deps.store, site.id));
    if (!cleared.ok) {
      return reply.code(cleared.status).send(fail(cleared.code, cleared.message));
    }
    return reply.code(204).send();
  };
}

// The share as a reader first meets it: whose numbers, in which zone, and
// whether a password stands in the way. Answered whether or not the reader
// holds the cookie, so a locked page can still say whose it is.
export function createGetShareController(deps: ApiDeps) {
  return async function getShareController(request: FastifyRequest, reply: FastifyReply) {
    const { token } = request.params as { token: string };
    const site = await deps.store.siteByShareToken(token);
    if (site === null || site.share === undefined) {
      return reply.code(404).send(fail('UNKNOWN_SHARE', 'No share answers to that link'));
    }
    const locked = site.share.passwordHash !== undefined;
    const unlocked =
      !locked || deps.shareCodec.read(request.cookies[SHARE_COOKIE], site.share, deps.now());
    return reply.header('x-robots-tag', 'noindex').send(
      ok({
        site: { name: site.name, timezone: site.settings.timezone },
        protected: locked,
        unlocked,
      }),
    );
  };
}

export function createUnlockShareController(deps: ApiDeps) {
  return async function unlockShareController(request: FastifyRequest, reply: FastifyReply) {
    const { token } = request.params as { token: string };
    const site = await deps.store.siteByShareToken(token);
    if (site === null || site.share === undefined) {
      return reply.code(404).send(fail('UNKNOWN_SHARE', 'No share answers to that link'));
    }
    const parsed = unlockShareSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'The password did not validate', parsed.error.issues));
    }
    if (site.share.passwordHash === undefined) {
      return reply.header('x-robots-tag', 'noindex').send(ok({ unlocked: true }));
    }
    if (!(await verifyPassword(site.share.passwordHash, parsed.data.password))) {
      return reply.code(401).send(fail('BAD_PASSWORD', 'That is not the password'));
    }
    const issued = deps.shareCodec.issue(site.share, deps.now());
    reply.setCookie(SHARE_COOKIE, issued.value, {
      // This share's routes and no other path, so the cookie of one link is
      // never presented for another.
      path: `/api/share/${token}`,
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.cookie.secure,
      maxAge: Math.floor(SHARE_TTL_MS / 1000),
    });
    return reply.header('x-robots-tag', 'noindex').send(ok({ unlocked: true }));
  };
}
