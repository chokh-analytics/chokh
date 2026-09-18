import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { recordIdentityRead } from '../services/audit.service.js';
import { user, userPresence, visitor } from '../services/people.service.js';

// One visitor's history, one identified person's history, and whether they are
// online.
//
// The visitor route is readable by anybody with read:stats, with the address and
// the name stripped out: a page path and a device are traffic. The two user routes
// are not, and the reason is worth stating: to reach them you have to already know
// the person's id, so the request itself is "tell me about this named person", and
// there is no version of that answer with the person taken out. They answer 403
// without read:identity, and every answer writes an audit row.

const VISITOR_ROUTE = 'GET /api/sites/:siteId/visitors/:visitorId';
const USER_ROUTE = 'GET /api/sites/:siteId/users/:userId';
const PRESENCE_ROUTE = 'GET /api/sites/:siteId/users/:userId/presence';

export function createVisitorController(deps: ApiDeps) {
  return async function visitorController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const { visitorId } = request.params as { visitorId: string };
    const allowed = request.grant?.scopes.has('read:identity') ?? false;
    const result = await visitor(deps.store, site.id, visitorId, allowed);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    if (result.data === null) {
      return reply
        .code(404)
        .send(fail('UNKNOWN_VISITOR', `No visitor ${visitorId} has been seen on ${site.id}`));
    }
    await recordIdentityRead(deps.store, {
      principal,
      siteId: site.id,
      route: VISITOR_ROUTE,
      target: visitorId,
      fields: result.data.fields,
      at: deps.now(),
    });
    return reply.send(ok(result.data.value, { identity: allowed }));
  };
}

export function createUserController(deps: ApiDeps) {
  return async function userController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const { userId } = request.params as { userId: string };
    const result = await user(deps.store, site.id, userId);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    if (result.data === null) {
      return reply
        .code(404)
        .send(fail('UNKNOWN_USER', `Nobody has been identified as ${userId} on ${site.id}`));
    }
    await recordIdentityRead(deps.store, {
      principal,
      siteId: site.id,
      route: USER_ROUTE,
      target: userId,
      fields: result.data.fields,
      at: deps.now(),
    });
    return reply.send(ok(result.data.value));
  };
}

export function createUserPresenceController(deps: ApiDeps) {
  return async function userPresenceController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const { userId } = request.params as { userId: string };
    const result = await userPresence(deps.store, site.id, userId);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    if (result.data === null) {
      return reply
        .code(404)
        .send(fail('UNKNOWN_USER', `Nobody has been identified as ${userId} on ${site.id}`));
    }
    // Asking "is this named person online" is a read about them whatever the
    // answer is, so the row is written even when they are not.
    await recordIdentityRead(deps.store, {
      principal,
      siteId: site.id,
      route: PRESENCE_ROUTE,
      target: userId,
      fields: ['userId'],
      at: deps.now(),
    });
    return reply.send(ok(result.data));
  };
}
