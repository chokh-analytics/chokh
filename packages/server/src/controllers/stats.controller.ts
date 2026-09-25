import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import {
  projectMetrics,
  propertiesQuerySchema,
  RANGE_BACKWARDS,
  statsQuerySchema,
  toStoreQuery,
  type StatsQueryInput,
} from '../schemas/stats.schema.js';
import { funnelStatsQuerySchema, journeysQuerySchema } from '../schemas/funnels.schema.js';
import { funnelRead } from '../services/funnels.service.js';
import { goalRead } from '../services/goals.service.js';
import {
  aggregate,
  breakdown,
  engagement,
  events,
  funnelStats,
  goalStats,
  journeys,
  properties,
  timeseries,
} from '../services/stats.service.js';
import type { Funnel, JourneyQuery, PropertyQuery, Query, Site } from '../store/AnalyticsStore.js';
import {
  breakdownTable,
  csvOf,
  engagementTable,
  eventsTable,
  funnelTable,
  goalsTable,
  isReportKind,
  journeysTable,
  propertiesTable,
  REPORT_KINDS,
  timeseriesTable,
  type CsvTable,
  type ReportKind,
} from '../lib/csv-report.js';

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

// What a read that goes to raw rows says about itself. A goal read is raw for
// its whole range, and so are the events and property reports, so each of them
// sees back as far as the site keeps its events and no further; a dashboard
// that has to say so should not need a second route for the number.
function rawMeta(site: Site, input: StatsQueryInput): Record<string, unknown> {
  return { ...meta(site, input), retentionDays: site.settings.retentionDays, rawOnly: true };
}

function metaFor(parsed: Parsed): Record<string, unknown> {
  return parsed.query.goal === undefined
    ? meta(parsed.site, parsed.input)
    : { ...rawMeta(parsed.site, parsed.input), goal: parsed.input.goal };
}

// The goal the query named, resolved against the site the route already read.
// A goal of another site is not here, so a key bound to one site can never
// borrow another's question; it answers 404 like any goal that does not exist.
async function withGoal(
  deps: ApiDeps,
  parsed: Parsed,
  reply: FastifyReply,
): Promise<Parsed | null> {
  if (parsed.input.goal === undefined) {
    return parsed;
  }
  const goal = await deps.store.goal(parsed.site.id, parsed.input.goal);
  if (goal === null) {
    void reply
      .code(404)
      .send(fail('GOAL_NOT_FOUND', `No goal ${parsed.input.goal} belongs to ${parsed.site.id}`));
    return null;
  }
  return { ...parsed, query: { ...parsed.query, goal: goalRead(goal) } };
}

async function parseWithGoal(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Parsed | null> {
  const parsed = parse(request, reply);
  return parsed === null ? null : withGoal(deps, parsed, reply);
}

export function createAggregateController(deps: ApiDeps) {
  return async function aggregateController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = await parseWithGoal(deps, request, reply);
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
        metaFor(parsed),
      ),
    );
  };
}

export function createTimeseriesController(deps: ApiDeps) {
  return async function timeseriesController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = await parseWithGoal(deps, request, reply);
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
    const parsed = await parseWithGoal(deps, request, reply);
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
            ...(row.conversion === undefined ? {} : { conversion: row.conversion }),
          })),
        },
        metaFor(parsed),
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
    const parsed = await parseWithGoal(deps, request, reply);
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
//
// Every report as a file (AN-RPT01): `report=` names the kind, absent means
// the breakdown this route always answered (rule 12), and the rest of the
// query is the report's own, parsed by the same functions the report's route
// uses, so a file and a page never disagree about what a range or a goal
// means.
export function createExportController(deps: ApiDeps) {
  return async function exportController(request: FastifyRequest, reply: FastifyReply) {
    const raw = request.query as Record<string, unknown>;
    const kind = raw.report === undefined ? 'breakdown' : raw.report;
    if (!isReportKind(kind)) {
      return reply
        .code(400)
        .send(fail('INVALID_QUERY', `report is one of ${REPORT_KINDS.join(', ')}`));
    }
    const exported = await exportTable(deps, kind, request, reply);
    if (exported === null) {
      return reply;
    }
    const day = (at: number): string => new Date(at).toISOString().slice(0, 10);
    const what = exported.detail === undefined ? kind : `${kind}-${exported.detail}`;
    return reply
      .type('text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${exported.site.id}-${what}-${day(exported.from)}-${day(exported.to)}.csv"`,
      )
      .send(csvOf(exported.table));
  };
}

interface Exported {
  table: CsvTable;
  site: Site;
  from: number;
  to: number;
  // What the file is of, when the kind alone does not say: the dimension, the
  // event, the funnel. Part of the file name and nothing else.
  detail?: string;
}

function exported(parsed: Pick<Parsed, 'site' | 'input'>, table: CsvTable, detail?: string): Exported {
  return {
    table,
    site: parsed.site,
    from: parsed.input.from,
    to: parsed.input.to,
    ...(detail === undefined ? {} : { detail }),
  };
}

function refused(reply: FastifyReply, result: { status: number; code: string; message: string }): null {
  void reply.code(result.status).send(fail(result.code, result.message));
  return null;
}

async function exportTable(
  deps: ApiDeps,
  kind: ReportKind,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Exported | null> {
  switch (kind) {
    case 'breakdown': {
      const parsed = await parseWithGoal(deps, request, reply);
      if (parsed === null) return null;
      const result = await breakdown(deps.store, parsed.query);
      if (!result.ok) return refused(reply, result);
      return exported(parsed, breakdownTable(result.data, parsed.query.goal !== undefined), result.data.dim);
    }
    case 'timeseries': {
      const parsed = await parseWithGoal(deps, request, reply);
      if (parsed === null) return null;
      const result = await timeseries(deps.store, parsed.query);
      if (!result.ok) return refused(reply, result);
      return exported(parsed, timeseriesTable(result.data));
    }
    case 'engagement': {
      const parsed = await parseWithGoal(deps, request, reply);
      if (parsed === null) return null;
      const result = await engagement(deps.store, parsed.query);
      if (!result.ok) return refused(reply, result);
      return exported(parsed, engagementTable(result.data), result.data.dim);
    }
    case 'events': {
      const parsed = await parseWithGoal(deps, request, reply);
      if (parsed === null) return null;
      const result = await events(deps.store, parsed.query);
      if (!result.ok) return refused(reply, result);
      return exported(parsed, eventsTable(result.data));
    }
    case 'properties': {
      const parsed = await parseProperties(deps, request, reply);
      if (parsed === null) return null;
      const result = await properties(deps.store, parsed.propertyQuery);
      if (!result.ok) return refused(reply, result);
      return exported(parsed, propertiesTable(result.data), result.data.event);
    }
    case 'goals': {
      const parsed = parse(request, reply);
      if (parsed === null) return null;
      if (parsed.input.goal !== undefined) {
        void reply
          .code(400)
          .send(fail('UNSUPPORTED_GOAL', 'The goals report answers every goal and takes none'));
        return null;
      }
      const goals = await deps.store.goals(parsed.site.id);
      const result = await goalStats(deps.store, parsed.query, goals);
      if (!result.ok) return refused(reply, result);
      return exported(parsed, goalsTable(result.data, goals));
    }
    case 'funnel': {
      const parsed = await parseFunnel(deps, request, reply);
      if (parsed === null) return null;
      const result = await funnelStats(deps.store, parsed.query, funnelRead(parsed.funnel));
      if (!result.ok) return refused(reply, result);
      return exported(parsed, funnelTable(result.data, parsed.funnel), parsed.funnel.id);
    }
    case 'journeys': {
      const parsed = parseJourneys(request, reply);
      if (parsed === null) return null;
      const result = await journeys(deps.store, parsed.query);
      if (!result.ok) return refused(reply, result);
      return exported(parsed, journeysTable(result.data));
    }
  }
}

// The custom events of the range, by name. Raw rows only, and the meta says so.
export function createEventsController(deps: ApiDeps) {
  return async function eventsController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = await parseWithGoal(deps, request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await events(deps.store, parsed.query);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    return reply.send(ok(result.data, rawMeta(parsed.site, parsed.input)));
  };
}

// One event broken down by one of its properties. The event is required, and
// said to be missing by name rather than as one issue among a validator's:
// it is the one thing this route cannot guess.
interface ParsedProperties extends Parsed {
  propertyQuery: PropertyQuery;
}

async function parseProperties(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ParsedProperties | null> {
  const site = request.site;
  if (site === null) {
    void reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    return null;
  }
  const raw = request.query as Record<string, unknown>;
  if (typeof raw.event !== 'string' || raw.event === '') {
    void reply.code(400).send(fail('MISSING_EVENT', 'A property breakdown needs an event'));
    return null;
  }
  const input = propertiesQuerySchema.safeParse(request.query);
  if (!input.success) {
    void reply
      .code(400)
      .send(fail('INVALID_QUERY', 'The query did not validate', input.error.issues));
    return null;
  }
  if (input.data.to <= input.data.from) {
    void reply.code(400).send(fail('INVALID_RANGE', RANGE_BACKWARDS));
    return null;
  }
  const parsed = await withGoal(
    deps,
    { query: toStoreQuery(site.id, input.data), input: input.data, site },
    reply,
  );
  if (parsed === null) {
    return null;
  }
  return {
    ...parsed,
    propertyQuery: {
      ...parsed.query,
      event: input.data.event,
      ...(input.data.property === undefined ? {} : { property: input.data.property }),
    },
  };
}

export function createPropertiesController(deps: ApiDeps) {
  return async function propertiesController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = await parseProperties(deps, request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await properties(deps.store, parsed.propertyQuery);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    return reply.send(ok(result.data, rawMeta(parsed.site, parsed.input)));
  };
}

// Every goal of the site, one conversion each. It answers all of them, so a
// goal named in the query is a question this route has no use for, and it says
// so rather than quietly answering something else.
export function createGoalStatsController(deps: ApiDeps) {
  return async function goalStatsController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parse(request, reply);
    if (parsed === null) {
      return reply;
    }
    if (parsed.input.goal !== undefined) {
      return reply
        .code(400)
        .send(fail('UNSUPPORTED_GOAL', 'The goals report answers every goal and takes none'));
    }
    const goals = await deps.store.goals(parsed.site.id);
    const result = await goalStats(deps.store, parsed.query, goals);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    const byId = new Map(goals.map((goal) => [goal.id, goal]));
    return reply.send(
      ok(
        {
          visitors: result.data.visitors,
          rows: result.data.rows.map((row) => ({
            goal: byId.get(row.goalId),
            conversion: row.conversion,
          })),
          rawOnly: true,
        },
        rawMeta(parsed.site, parsed.input),
      ),
    );
  };
}

// A report that has no use for a goal says so rather than quietly answering
// something else, the way the goals report does.
function refuseGoal(input: { goal?: string | undefined }, reply: FastifyReply, what: string): boolean {
  if (input.goal === undefined) {
    return false;
  }
  void reply.code(400).send(fail('UNSUPPORTED_GOAL', `${what} cannot be counted against a goal`));
  return true;
}

// How far the people of the range got through one funnel, named by id and
// resolved against the site the route already read, so a key of one site can
// never read another site's funnel. Raw rows only, and the meta says so.
interface ParsedFunnel {
  query: Query;
  input: StatsQueryInput;
  site: Site;
  funnel: Funnel;
}

async function parseFunnel(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ParsedFunnel | null> {
  const site = request.site;
  if (site === null) {
    void reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    return null;
  }
  const raw = request.query as Record<string, unknown>;
  if (typeof raw.funnel !== 'string' || raw.funnel === '') {
    void reply.code(400).send(fail('MISSING_FUNNEL', 'A funnel report needs a funnel'));
    return null;
  }
  const input = funnelStatsQuerySchema.safeParse(request.query);
  if (!input.success) {
    void reply
      .code(400)
      .send(fail('INVALID_QUERY', 'The query did not validate', input.error.issues));
    return null;
  }
  if (input.data.to <= input.data.from) {
    void reply.code(400).send(fail('INVALID_RANGE', RANGE_BACKWARDS));
    return null;
  }
  if (refuseGoal(input.data, reply, 'A funnel')) {
    return null;
  }
  const funnel = await deps.store.funnel(site.id, input.data.funnel);
  if (funnel === null) {
    void reply
      .code(404)
      .send(fail('FUNNEL_NOT_FOUND', `No funnel ${input.data.funnel} belongs to ${site.id}`));
    return null;
  }
  return { query: toStoreQuery(site.id, input.data), input: input.data, site, funnel };
}

export function createFunnelStatsController(deps: ApiDeps) {
  return async function funnelStatsController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = await parseFunnel(deps, request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await funnelStats(deps.store, parsed.query, funnelRead(parsed.funnel));
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    return reply.send(
      ok(
        { funnel: parsed.funnel, ...result.data },
        { ...rawMeta(parsed.site, parsed.input), funnel: parsed.funnel.id },
      ),
    );
  };
}

// The paths the range's visits took. Raw rows only, and the meta says so.
function parseJourneys(
  request: FastifyRequest,
  reply: FastifyReply,
): { query: JourneyQuery; input: StatsQueryInput; site: Site } | null {
  const site = request.site;
  if (site === null) {
    void reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    return null;
  }
  const input = journeysQuerySchema.safeParse(request.query);
  if (!input.success) {
    void reply
      .code(400)
      .send(fail('INVALID_QUERY', 'The query did not validate', input.error.issues));
    return null;
  }
  if (input.data.to <= input.data.from) {
    void reply.code(400).send(fail('INVALID_RANGE', RANGE_BACKWARDS));
    return null;
  }
  if (refuseGoal(input.data, reply, 'The journeys report')) {
    return null;
  }
  const query = toStoreQuery(site.id, input.data);
  return {
    query: input.data.branches === undefined ? query : { ...query, branches: input.data.branches },
    input: input.data,
    site,
  };
}

export function createJourneysController(deps: ApiDeps) {
  return async function journeysController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parseJourneys(request, reply);
    if (parsed === null) {
      return reply;
    }
    const result = await journeys(deps.store, parsed.query);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    return reply.send(ok(result.data, rawMeta(parsed.site, parsed.input)));
  };
}
