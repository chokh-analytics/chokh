import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import {
  coverageQuerySchema,
  errorsQuerySchema,
  vitalsQuerySchema,
} from '../schemas/site-health.schema.js';
import { coverage, errors, vitals } from '../services/site-health.service.js';
import type { VitalsQuery } from '../store/AnalyticsStore.js';
import { parse, rawMeta } from './retention.controller.js';

// The health reports (AN-VIT01): Core Web Vitals and the slow pages, the
// JavaScript errors, and the tracker's coverage of the signed-in traffic. Each
// reads raw rows for its whole range, so the meta says rawOnly and how far back
// this site keeps them, the way the retention reads do. None names a person:
// see health.service.ts for where that line is drawn.

export function createVitalsController(deps: ApiDeps) {
  return async function vitalsController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(vitalsQuerySchema, request, reply);
    if (parsed === null) return reply;
    const { site, input } = parsed;
    const query: VitalsQuery = { siteId: site.id, from: input.from, to: input.to, sort: input.sort };
    if (input.device !== undefined) query.device = input.device;
    const result = await vitals(deps.store, query);
    if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
    return reply.send(
      ok(result.data, { ...rawMeta(site, input), sort: input.sort, device: input.device ?? null }),
    );
  };
}

export function createErrorsController(deps: ApiDeps) {
  return async function errorsController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(errorsQuerySchema, request, reply);
    if (parsed === null) return reply;
    const { site, input } = parsed;
    const result = await errors(deps.store, {
      siteId: site.id,
      from: input.from,
      to: input.to,
      limit: input.limit,
    });
    if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
    return reply.send(
      ok(result.data, {
        ...rawMeta(site, input),
        limit: input.limit,
        // So a dashboard can tell "nothing broke" from "nothing is collected".
        errorCapture: site.settings.errorCapture === true,
        errorStacks: site.settings.errorStacks === true,
      }),
    );
  };
}

export function createCoverageController(deps: ApiDeps) {
  return async function coverageController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(coverageQuerySchema, request, reply);
    if (parsed === null) return reply;
    const { site, input } = parsed;
    const result = await coverage(deps.store, { siteId: site.id, from: input.from, to: input.to });
    if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
    return reply.send(ok(result.data, rawMeta(site, input)));
  };
}
