import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { decodePeopleCursor, encodePeopleCursor } from '../lib/people-cursor.js';
import { peopleQuerySchema } from '../schemas/people.schema.js';
import { recordIdentityRead } from '../services/audit.service.js';
import { people, user, userPresence, visitor } from '../services/people.service.js';
import type { PeopleList, PeopleQuery } from '../store/AnalyticsStore.js';

// The directory of everybody, one visitor's history, one identified person's
// history, and whether they are online.
//
// The visitor route is readable by anybody with read:stats, with the address and
// the name stripped out: a page path and a device are traffic. The two user routes
// are not, and the reason is worth stating: to reach them you have to already know
// the person's id, so the request itself is "tell me about this named person", and
// there is no version of that answer with the person taken out. They answer 403
// without read:identity, and every answer writes an audit row.
//
// The directory sits between the two. Listing visitors is read:stats, stripped
// like the visitor route, because a page of browsers is traffic. Searching it is
// not: q matches a userId and a trait as well as a visitor id, so a search is
// "find this named person" and is refused without read:identity before the store
// is asked anything.

const PEOPLE_ROUTE = 'GET /api/sites/:siteId/people';
const VISITOR_ROUTE = 'GET /api/sites/:siteId/visitors/:visitorId';
const USER_ROUTE = 'GET /api/sites/:siteId/users/:userId';
const PRESENCE_ROUTE = 'GET /api/sites/:siteId/users/:userId/presence';

export function createPeopleController(deps: ApiDeps) {
  return async function peopleController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = peopleQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_PEOPLE_QUERY', 'The query did not validate', parsed.error.issues));
    }
    const input = parsed.data;
    const allowed = request.grant?.scopes.has('read:identity') ?? false;
    if (input.q !== undefined && !allowed) {
      return reply
        .code(403)
        .send(
          fail(
            'SCOPE_REQUIRED',
            'Searching people can match a userId or a trait, so it needs the read:identity scope',
          ),
        );
    }
    const query: PeopleQuery = { siteId: site.id, limit: input.limit };
    if (input.identifiedOnly) query.identifiedOnly = true;
    if (input.q !== undefined) query.q = input.q;
    if (input.cursor !== undefined) {
      const after = decodePeopleCursor(input.cursor);
      if (after === null) {
        return reply
          .code(400)
          .send(fail('INVALID_CURSOR', 'That cursor was not written by this server'));
      }
      query.after = after;
    }
    const result = await people(deps.store, query, allowed);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    const page = result.data.value;
    const fields = result.data.fields;
    // One row per page read, not one per person on it: the read was one act.
    // The search is the target when there is one, because "who looked for
    // Ada" is the question the log exists to answer.
    const audit: Parameters<typeof recordIdentityRead>[1] = {
      principal,
      siteId: site.id,
      route: PEOPLE_ROUTE,
      fields,
      at: deps.now(),
    };
    if (input.q !== undefined) audit.target = input.q;
    await recordIdentityRead(deps.store, audit);
    const body: PeopleList = {
      people: page.people,
      next: page.next === null ? null : encodePeopleCursor(page.next),
    };
    return reply.send(ok(body, { identity: allowed, limit: input.limit }));
  };
}

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
