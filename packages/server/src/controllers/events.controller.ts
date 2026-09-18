import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { serverBatchSchema } from '../schemas/events.schema.js';
import { sendServerEvents } from '../services/server-events.service.js';

// POST /api/sites/:siteId/events: what @chokh/sdk-node posts.
//
// Unlike the collector this answers with a body, because the caller is a program
// that wants to know which visitor its event landed on: a backend sending
// order_paid has no visitor id of its own, and the one this resolved is worth
// telling it.
export function createServerEventsController(deps: ApiDeps) {
  return async function serverEventsController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Present a key with write:events'));
    }
    const parsed = serverBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BATCH', 'The batch did not validate', parsed.error.issues));
    }

    const result = await sendServerEvents(
      { store: deps.store, now: deps.now },
      site,
      parsed.data,
    );
    // A server event never touches presence, so there is nothing to nudge the
    // realtime stream about: nobody came online.
    return reply.code(202).send(ok(result));
  };
}
