import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { attempt } from '../lib/store-error.js';
import { createGoalSchema, goalParamsSchema } from '../schemas/goals.schema.js';
import { createGoal } from '../services/goals.service.js';
import { goalIdFor, MAX_GOALS_PER_SITE } from '../store/AnalyticsStore.js';

// A site's goals: list them, add one, delete one.
//
// Reading the list is read:stats, because anybody who can read a report can see
// what it is being measured against. Adding and deleting are admin, the scope a
// site's settings already need: a goal changes what every report of the site
// says. Both are decided per route in api.routes.ts.

export function createListGoalsController(deps: ApiDeps) {
  return async function listGoalsController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return reply.send(
      ok({ goals: await deps.store.goals(site.id) }, { siteId: site.id, max: MAX_GOALS_PER_SITE }),
    );
  };
}

export function createCreateGoalController(deps: ApiDeps) {
  return async function createGoalController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = createGoalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_GOAL', 'The goal did not validate', parsed.error.issues));
    }
    const created = await attempt(() =>
      createGoal(deps.store, {
        ...parsed.data,
        siteId: site.id,
        createdBy: principal.id,
        now: deps.now(),
      }),
    );
    if (!created.ok) {
      // The goal that already asks this question, so a caller can use it
      // rather than being told only that it exists.
      const details =
        created.code === 'GOAL_EXISTS'
          ? { goalId: goalIdFor(site.id, parsed.data.kind, parsed.data.match) }
          : undefined;
      return reply.code(created.status).send(fail(created.code, created.message, details));
    }
    return reply.code(201).send(ok({ goal: created.data }));
  };
}

export function createDeleteGoalController(deps: ApiDeps) {
  return async function deleteGoalController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const params = goalParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(fail('INVALID_PARAMS', 'The goal id did not validate', params.error.issues));
    }
    const deleted = await deps.store.deleteGoal(site.id, params.data.goalId);
    if (!deleted) {
      return reply
        .code(404)
        .send(fail('GOAL_NOT_FOUND', `No goal ${params.data.goalId} belongs to ${site.id}`));
    }
    return reply.send(ok({ deleted: true }));
  };
}
