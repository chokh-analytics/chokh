import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { createFunnelSchema, funnelParamsSchema } from '../schemas/funnels.schema.js';
import { createFunnel } from '../services/funnels.service.js';
import {
  FUNNEL_WINDOWS,
  MAX_FUNNEL_STEPS,
  MAX_FUNNELS_PER_SITE,
  defaultFunnelWindow,
} from '../store/AnalyticsStore.js';

// A site's funnels: list them, add one, delete one.
//
// The same split as goals: reading the list is read:stats, adding and deleting
// are admin, because a funnel is part of what the site's reports say. Both are
// decided per route in api.routes.ts.

export function createListFunnelsController(deps: ApiDeps) {
  return async function listFunnelsController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return reply.send(
      ok(
        { funnels: await deps.store.funnels(site.id) },
        {
          siteId: site.id,
          max: MAX_FUNNELS_PER_SITE,
          maxSteps: MAX_FUNNEL_STEPS,
          windows: FUNNEL_WINDOWS,
          // What a builder offers first on this site.
          defaultWindow: defaultFunnelWindow(site.settings.visitorIdMode),
        },
      ),
    );
  };
}

export function createCreateFunnelController(deps: ApiDeps) {
  return async function createFunnelController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = createFunnelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_FUNNEL', 'The funnel did not validate', parsed.error.issues));
    }
    const created = await createFunnel(deps.store, {
      ...parsed.data,
      site,
      createdBy: principal.id,
      now: deps.now(),
    });
    if (!created.ok) {
      // Which step named a goal that is not here, or which funnel already asks
      // this question, so a caller can point at it rather than only being told.
      const details =
        created.step !== undefined
          ? { step: created.step }
          : created.funnelId !== undefined
            ? { funnelId: created.funnelId }
            : undefined;
      return reply.code(created.status).send(fail(created.code, created.message, details));
    }
    return reply.code(201).send(ok({ funnel: created.data }));
  };
}

export function createDeleteFunnelController(deps: ApiDeps) {
  return async function deleteFunnelController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const params = funnelParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(fail('INVALID_PARAMS', 'The funnel id did not validate', params.error.issues));
    }
    const deleted = await deps.store.deleteFunnel(site.id, params.data.funnelId);
    if (!deleted) {
      return reply
        .code(404)
        .send(fail('FUNNEL_NOT_FOUND', `No funnel ${params.data.funnelId} belongs to ${site.id}`));
    }
    return reply.send(ok({ deleted: true }));
  };
}
