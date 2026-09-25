import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { badgeSvg, compactCount } from '../lib/badge.js';
import { fail } from '../lib/envelope.js';
import { aggregate } from '../services/stats.service.js';
import { addDays, dayBounds, dayKey } from '../store/AnalyticsStore.js';

// The stat badge under a share (AN-RPT01): one metric over one of three
// ranges, in the site's own zone, as an SVG a README carries as an image.
// The same read as the shared page's first tile, behind the same hook, so a
// locked share's badge is locked too. Cached five minutes: an image in a
// README is fetched by everybody who opens it.

const METRICS = {
  visitors: 'Visitors',
  pageviews: 'Pageviews',
} as const;

const RANGES = {
  today: { back: 0, words: 'today' },
  '7d': { back: 6, words: '7 days' },
  '30d': { back: 29, words: '30 days' },
} as const;

type WidgetMetric = keyof typeof METRICS;
type WidgetRange = keyof typeof RANGES;

function isMetric(value: unknown): value is WidgetMetric {
  return typeof value === 'string' && value in METRICS;
}

function isRange(value: unknown): value is WidgetRange {
  return typeof value === 'string' && value in RANGES;
}

export function createWidgetController(deps: ApiDeps) {
  return async function widgetController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const raw = request.query as Record<string, unknown>;
    const metric = raw.metric ?? 'visitors';
    const range = raw.range ?? '30d';
    if (!isMetric(metric)) {
      return reply
        .code(400)
        .send(fail('INVALID_QUERY', `metric is one of ${Object.keys(METRICS).join(', ')}`));
    }
    if (!isRange(range)) {
      return reply
        .code(400)
        .send(fail('INVALID_QUERY', `range is one of ${Object.keys(RANGES).join(', ')}`));
    }
    const now = deps.now();
    const timezone = site.settings.timezone;
    const from = dayBounds(addDays(dayKey(now, timezone), -RANGES[range].back), timezone).start;
    const result = await aggregate(deps.store, { siteId: site.id, from, to: now });
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    const value = result.data.metrics[metric];
    return reply
      .type('image/svg+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header('x-robots-tag', 'noindex')
      .send(badgeSvg(`${METRICS[metric]}, ${RANGES[range].words}`, compactCount(value)));
  };
}
