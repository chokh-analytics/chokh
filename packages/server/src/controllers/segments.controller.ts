import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { attempt } from '../lib/store-error.js';
import { createSegmentSchema, segmentParamsSchema } from '../schemas/segments.schema.js';
import { createSegment } from '../services/segments.service.js';
import {
  canonicalFilters,
  segmentIdFor,
  MAX_SEGMENTS_PER_SITE,
} from '../store/AnalyticsStore.js';

// A site's segments: list them, add one, delete one.
//
// Reading the list is read:stats, because anybody who can read a report may
// narrow it, and a saved narrowing is no more than that. Adding and deleting
// are admin, the scope goals and funnels take: a segment is shared by everybody
// who reads the site, so who may change the shared list is who may change the
// site. Both are decided per route in api.routes.ts.

export function createListSegmentsController(deps: ApiDeps) {
  return async function listSegmentsController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return reply.send(
      ok(
        { segments: await deps.store.segments(site.id) },
        { siteId: site.id, max: MAX_SEGMENTS_PER_SITE },
      ),
    );
  };
}

export function createCreateSegmentController(deps: ApiDeps) {
  return async function createSegmentController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = createSegmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_SEGMENT', 'The segment did not validate', parsed.error.issues));
    }
    const created = await attempt(() =>
      createSegment(deps.store, {
        ...parsed.data,
        siteId: site.id,
        createdBy: principal.id,
        now: deps.now(),
      }),
    );
    if (!created.ok) {
      // The segment that already saves these filters, so a caller can use it
      // rather than being told only that it exists.
      const details =
        created.code === 'SEGMENT_EXISTS'
          ? { segmentId: segmentIdFor(site.id, canonicalFilters(parsed.data.filters)) }
          : undefined;
      return reply.code(created.status).send(fail(created.code, created.message, details));
    }
    return reply.code(201).send(ok({ segment: created.data }));
  };
}

export function createDeleteSegmentController(deps: ApiDeps) {
  return async function deleteSegmentController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const params = segmentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(fail('INVALID_PARAMS', 'The segment id did not validate', params.error.issues));
    }
    const deleted = await deps.store.deleteSegment(site.id, params.data.segmentId);
    if (!deleted) {
      return reply
        .code(404)
        .send(
          fail('SEGMENT_NOT_FOUND', `No segment ${params.data.segmentId} belongs to ${site.id}`),
        );
    }
    return reply.send(ok({ deleted: true }));
  };
}
