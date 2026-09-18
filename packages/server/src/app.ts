import { emptyReader, type GeoReader } from '@chokh/geo';
import Fastify, {
  type FastifyBodyParser,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import { env } from './config/env.js';
import { fail } from './lib/envelope.js';
import { createWindowCounter } from './lib/window-counter.js';
import { registerDashboard } from './plugins/dashboard.js';
import { registerCollectRoutes } from './routes/collect.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { createDedupe } from './services/dedupe.js';
import { createVisitorIdSource } from './services/visitor-id.js';
import type { AnalyticsStore } from './store/AnalyticsStore.js';
import { createMemoryStore } from './store/memory.store.js';

const MINUTE_MS = 60_000;

export interface AppOptions {
  // server.ts chooses the adapter from the environment. Without one, a test
  // or a bare instance runs on memory and keeps nothing across a restart.
  store?: AnalyticsStore;
  // server.ts opens the database and swaps it in once the refresh job has one.
  geo?: GeoReader;
}

function wantsHtml(accept: string | undefined): boolean {
  return accept !== undefined && accept.includes('text/html');
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: env.TRUST_PROXY.length === 0 ? false : env.TRUST_PROXY,
  });

  // The tracker posts JSON under a text/plain content type, because a beacon
  // cannot be preflighted and only a simple content type survives a
  // cross-origin post. The body is read as JSON whatever the header says.
  const parseJsonBody: FastifyBodyParser<string> = (_request, body, done) => {
    if (body === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch {
      done(
        Object.assign(new Error('The body is not valid JSON'), {
          statusCode: 400,
          code: 'INVALID_JSON',
        }),
        undefined,
      );
    }
  };
  // Fastify parses text/plain into a string of its own accord, so that one is
  // replaced by name and everything else falls to the wildcard.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, parseJsonBody);
  app.addContentTypeParser('*', { parseAs: 'string' }, parseJsonBody);

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = error.statusCode ?? 500;
    // A public collector is posted nonsense all day. Only a fault of ours is an
    // error; a body the client got wrong is a warning.
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.warn({ err: error }, 'request refused');
    }
    // A plain Error thrown by a handler reaches here without a code, so the
    // type is wider than the framework's declaration admits.
    const rawCode: string | undefined = error.code;
    const code = status === 500 ? 'INTERNAL_ERROR' : (rawCode ?? 'REQUEST_ERROR');
    const message = status === 500 ? 'Internal server error' : error.message;
    return reply.code(status).send(fail(code, message));
  });

  await registerHealthRoutes(app);

  await registerCollectRoutes(
    app,
    {
      store: options.store ?? createMemoryStore(),
      geo: options.geo ?? emptyReader,
      visitorIds: createVisitorIdSource(),
      ipLimit: createWindowCounter(MINUTE_MS),
      siteLimit: createWindowCounter(MINUTE_MS),
      visitorRate: createWindowCounter(MINUTE_MS),
      dedupe: createDedupe(),
      limits: { perIp: env.COLLECT_RATE_LIMIT_IP, perSite: env.COLLECT_RATE_LIMIT_SITE },
      now: () => Date.now(),
    },
    { trustProxy: env.TRUST_PROXY, realIpHeader: env.REAL_IP_HEADER },
  );

  const dashboardRoot = await registerDashboard(app);

  app.setNotFoundHandler((request, reply) => {
    // A browser asking for a dashboard route gets the single page app; anything
    // else gets the failure envelope.
    if (dashboardRoot !== null && request.method === 'GET' && wantsHtml(request.headers.accept)) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply
      .code(404)
      .send(fail('NOT_FOUND', `Route ${request.method} ${request.url} not found`));
  });

  return app;
}
