import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { attempt } from '../lib/store-error.js';
import {
  annotationParamsSchema,
  annotationRangeSchema,
  createAnnotationSchema,
} from '../schemas/annotations.schema.js';
import { createAnnotation } from '../services/annotations.service.js';
import {
  annotationIdFor,
  MAX_ANNOTATIONS_PER_SITE,
  type AnnotationKind,
} from '../store/AnalyticsStore.js';

// A site's annotations: the range's marks, add one, delete one.
//
// Reading is read:stats, because a mark is part of the chart everybody who
// reads the site sees. Adding and deleting are write:events: an annotation is
// a fact stated about the site, the same trust a server event carries, so the
// key a deploy pipeline already holds can post one and an editor can note a
// campaign from the dashboard. Both are decided per route in api.routes.ts.

export function createListAnnotationsController(deps: ApiDeps) {
  return async function listAnnotationsController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const range = annotationRangeSchema.safeParse(request.query);
    if (!range.success) {
      return reply
        .code(400)
        .send(fail('INVALID_RANGE', 'The range did not validate', range.error.issues));
    }
    return reply.send(
      ok(
        { annotations: await deps.store.annotations(site.id, range.data.from, range.data.to) },
        { siteId: site.id, from: range.data.from, to: range.data.to, max: MAX_ANNOTATIONS_PER_SITE },
      ),
    );
  };
}

export function createCreateAnnotationController(deps: ApiDeps) {
  return async function createAnnotationController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = createAnnotationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_ANNOTATION', 'The annotation did not validate', parsed.error.issues));
    }
    const created = await attempt(() =>
      createAnnotation(deps.store, {
        ...parsed.data,
        siteId: site.id,
        createdBy: principal.id,
        now: deps.now(),
      }),
    );
    if (!created.ok) {
      // The annotation that already states this, so a retrying pipeline can
      // read the answer as success rather than as a fault.
      const details =
        created.code === 'ANNOTATION_EXISTS'
          ? {
              annotationId: annotationIdFor(
                site.id,
                parsed.data.at,
                parsed.data.kind as AnnotationKind,
                parsed.data.text,
              ),
            }
          : undefined;
      return reply.code(created.status).send(fail(created.code, created.message, details));
    }
    return reply.code(201).send(ok({ annotation: created.data }));
  };
}

export function createDeleteAnnotationController(deps: ApiDeps) {
  return async function deleteAnnotationController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const params = annotationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(fail('INVALID_PARAMS', 'The annotation id did not validate', params.error.issues));
    }
    const deleted = await deps.store.deleteAnnotation(site.id, params.data.annotationId);
    if (!deleted) {
      return reply
        .code(404)
        .send(
          fail(
            'ANNOTATION_NOT_FOUND',
            `No annotation ${params.data.annotationId} belongs to ${site.id}`,
          ),
        );
    }
    return reply.send(ok({ deleted: true }));
  };
}
