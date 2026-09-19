import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import {
  projectMetrics,
  RANGE_BACKWARDS,
  statsQuerySchema,
  toStoreQuery,
  type StatsQueryInput,
} from '../schemas/stats.schema.js';
import {
  aggregate,
  breakdown,
  breakdownCsv,
  engagement,
  timeseries,
} from '../services/stats.service.js';
import type { Query, Site } from '../store/AnalyticsStore.js';

// The three reports and the export. Each one validates the query string, hands the
// store's own query shape to the service, and answers with the envelope; the meta
// carries the site and the range that was actually read, so a chart can label
// itself without recomputing a timezone.

interface Parsed {
  query: Query;
  input: StatsQueryInput;
  site: Site;
}

function parse(
  request: FastifyRequest,
  reply: FastifyReply,
): Parsed | null {
  const site = request.site;
  if (site === null) {
    void reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    return null;
  }
  const parsed = statsQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    void reply
      .code(400)
      .send(fail('INVALID_QUERY', 'The query did not validate', parsed.error.issues));
    return null;
  }
  if (parsed.data.to <= parsed.data.from) {
    // An empty range answers zero for everything, which reads as "nobody came"
    // rather than "you asked for nothing". Refused instead.
    void reply.code(400).send(fail('INVALID_RANGE', RANGE_BACKWARDS));
    return null;
  }
  return { query: toStoreQuery(site.id, parsed.data), input: parsed.data, site };
}

function meta(site: Site, input: StatsQueryInput): Record<string, unknown> {
  return { siteId: site.id, timezone: site.settings.timezone, from: input.from, to: input.to };
}

export function createAggregateController(deps: ApiDeps) {
  return async function aggregateController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await aggregate(deps.store, parsed.query);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    const { metrics, previous, ...rest } = result.data;
    return reply.send(
      ok(
        {
          ...rest,
          metrics: projectMetrics(metrics, parsed.input.metrics),
          previous: previous === null ? null : projectMetrics(previous, parsed.input.metrics),
        },
        meta(parsed.site, parsed.input),
      ),
    );
  };
}

export function createTimeseriesController(deps: ApiDeps) {
  return async function timeseriesController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await timeseries(deps.store, parsed.query);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    const project = (points: typeof result.data.points): unknown[] =>
      points.map((point) => ({
        ...point,
        metrics: projectMetrics(point.metrics, parsed.input.metrics),
      }));
    return reply.send(
      ok(
        {
          interval: result.data.interval,
          points: project(result.data.points),
          previous: result.data.previous === null ? null : project(result.data.previous),
        },
        meta(parsed.site, parsed.input),
      ),
    );
  };
}

export function createBreakdownController(deps: ApiDeps) {
  return async function breakdownController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await breakdown(deps.store, parsed.query);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    return reply.send(
      ok(
        {
          dim: result.data.dim,
          rows: result.data.rows.map((row) => ({
            key: row.key,
            metrics: projectMetrics(row.metrics, parsed.input.metrics),
          })),
        },
        meta(parsed.site, parsed.input),
      ),
    );
  };
}

// Time on page and scroll depth. A separate route rather than two more metrics
// on a breakdown, because these two are averages over leave beacons and the
// others are counts over every row: putting them in one response would mean a
// page with no leave beacon reporting a bounce rate beside a time on page that
// is not missing but unmeasured, and the two would look like the same kind of
// number.
export function createEngagementController(deps: ApiDeps) {
  return async function engagementController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await engagement(deps.store, parsed.query);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    // rawOnly says this report cannot see past the raw events. How far back
    // that is belongs beside it: a dashboard that has to tell somebody "this
    // sees back 180 days" should not have to ask a second route for the number,
    // and a reader looking at a 400 day range with 30 days of leave beacons in
    // it deserves to be told which it is.
    return reply.send(
      ok(result.data, {
        ...meta(parsed.site, parsed.input),
        retentionDays: parsed.site.settings.retentionDays,
      }),
    );
  };
}

// The one route whose success is not the envelope, because a download is a file
// and not a message. Every refusal on it still is: a 400 from here is the same
// shape as a 400 from anywhere else, which is what rule 6 is protecting.
export function createExportController(deps: ApiDeps) {
  return async function exportController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await breakdownCsv(deps.store, parsed.query);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    const day = new Date(parsed.input.from).toISOString().slice(0, 10);
    return reply
      .type('text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${parsed.site.id}-${result.data.dim}-${day}.csv"`,
      )
      .send(result.data.body);
  };
}
