import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import {
  activityQuerySchema,
  attributionQuerySchema,
  cohortsQuerySchema,
  powerUsersQuerySchema,
} from '../schemas/retention.schema.js';
import { RANGE_BACKWARDS } from '../schemas/stats.schema.js';
import { recordIdentityRead } from '../services/audit.service.js';
import { goalRead } from '../services/goals.service.js';
import { powerUsers } from '../services/people.service.js';
import { activity, attribution, cohorts } from '../services/retention.service.js';
import type { PowerUsersQuery, Site } from '../store/AnalyticsStore.js';

// The retention reports (AN-PPL01): cohorts, stickiness, the power users and
// attribution. Each reads stay rows (attribution the goal's own raw rows) for
// its whole range, so the meta says rawOnly and how far back this site keeps
// them, the way the other raw reads do.
//
// The power users route names people, so it goes through the identity gate
// exactly as GET /people does: read:stats lists them with the address, the
// name and the traits stripped; read:identity keeps them, and a page that
// carries any writes one audit row.

const POWER_USERS_ROUTE = 'GET /api/sites/:siteId/stats/power-users';

interface Range {
  from: number;
  to: number;
}

function parse<S extends z.ZodType<Range, z.ZodTypeDef, unknown>>(
  schema: S,
  request: FastifyRequest,
  reply: FastifyReply,
): { site: Site; input: z.output<S> } | null {
  const site = request.site;
  if (site === null) {
    void reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    return null;
  }
  const parsed = schema.safeParse(request.query);
  if (!parsed.success) {
    void reply
      .code(400)
      .send(fail('INVALID_QUERY', 'The query did not validate', parsed.error.issues));
    return null;
  }
  const input: z.output<S> = parsed.data;
  if (input.to <= input.from) {
    void reply.code(400).send(fail('INVALID_RANGE', RANGE_BACKWARDS));
    return null;
  }
  return { site, input };
}

function rawMeta(site: Site, range: Range): Record<string, unknown> {
  return {
    siteId: site.id,
    timezone: site.settings.timezone,
    from: range.from,
    to: range.to,
    retentionDays: site.settings.retentionDays,
    // A dashboard says why a grid stays empty on an install whose visitor ids
    // last a day.
    visitorIdMode: site.settings.visitorIdMode,
    rawOnly: true,
  };
}

export function createCohortsController(deps: ApiDeps) {
  return async function cohortsController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(cohortsQuerySchema, request, reply);
    if (parsed === null) return reply;
    const { site, input } = parsed;
    const result = await cohorts(deps.store, {
      siteId: site.id,
      from: input.from,
      to: input.to,
      interval: input.interval,
    });
    if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
    return reply.send(ok(result.data, { ...rawMeta(site, input), interval: input.interval }));
  };
}

export function createActivityController(deps: ApiDeps) {
  return async function activityController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(activityQuerySchema, request, reply);
    if (parsed === null) return reply;
    const { site, input } = parsed;
    const result = await activity(deps.store, { siteId: site.id, from: input.from, to: input.to });
    if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
    return reply.send(ok(result.data, rawMeta(site, input)));
  };
}

export function createAttributionController(deps: ApiDeps) {
  return async function attributionController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(attributionQuerySchema, request, reply);
    if (parsed === null) return reply;
    const { site, input } = parsed;
    // A goal of another site is not here, so a key bound to one site can never
    // borrow another's question: 404 like any goal that does not exist.
    const goal = await deps.store.goal(site.id, input.goal);
    if (goal === null) {
      return reply
        .code(404)
        .send(fail('GOAL_NOT_FOUND', `No goal ${input.goal} belongs to ${site.id}`));
    }
    const result = await attribution(deps.store, {
      siteId: site.id,
      from: input.from,
      to: input.to,
      goal: goalRead(goal),
      dim: input.dim,
    });
    if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
    return reply.send(ok(result.data, { ...rawMeta(site, input), goal: goal.id, dim: input.dim }));
  };
}

export function createPowerUsersController(deps: ApiDeps) {
  return async function powerUsersController(request: FastifyRequest, reply: FastifyReply) {
    const principal = request.principal;
    if (principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = parse(powerUsersQuerySchema, request, reply);
    if (parsed === null) return reply;
    const { site, input } = parsed;
    const allowed = request.grant?.scopes.has('read:identity') ?? false;
    // With no minDays the store takes a third of the range's days in the
    // site's calendar, which only it can count.
    const query: PowerUsersQuery = {
      siteId: site.id,
      from: input.from,
      to: input.to,
      limit: input.limit,
    };
    if (input.minDays !== undefined) query.minDays = input.minDays;
    const result = await powerUsers(deps.store, query, allowed);
    if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
    // One row per page read, as the directory writes: the read was one act.
    await recordIdentityRead(deps.store, {
      principal,
      siteId: site.id,
      route: POWER_USERS_ROUTE,
      fields: result.data.fields,
      at: deps.now(),
    });
    return reply.send(
      ok(result.data.value, { ...rawMeta(site, input), identity: allowed, limit: input.limit }),
    );
  };
}
