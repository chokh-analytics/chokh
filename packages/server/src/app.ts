import { emptyReader, type GeoReader } from '@chokh/geo';
import Fastify, {
  type FastifyBodyParser,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import fastifyCookie from '@fastify/cookie';

import { cookieSecure, env, resolveSessionSecret } from './config/env.js';
import type { ApiDeps } from './lib/api-deps.js';
import type { ClientIpOptions } from './lib/client-ip.js';
import { fail } from './lib/envelope.js';
import { createWindowCounter } from './lib/window-counter.js';
import { registerAuthDecorations } from './plugins/auth.js';
import { openBus, openOnce } from './plugins/bus.js';
import { registerDashboard } from './plugins/dashboard.js';
import { registerApiRoutes } from './routes/api.routes.js';
import { registerCollectRoutes } from './routes/collect.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { createSessionCodec } from './services/auth.service.js';
import type { Bus } from './services/bus.js';
import { createDedupe } from './services/dedupe.js';
import type { OnceOnly } from './services/once.js';
import { createVisitorIdSource } from './services/visitor-id.js';
import type { AccountStore, AnalyticsStore, Presence } from './store/AnalyticsStore.js';
import { createMemoryStore } from './store/memory.store.js';

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * 60 * 1000;

export interface AppOptions {
  // server.ts chooses the adapter from the environment. Without one, a test
  // or a bare instance runs on memory and keeps nothing across a restart.
  store?: AnalyticsStore & AccountStore;
  // Where ingest writes who is here now. Only used when this builds the store
  // itself; server.ts hands the presence to the adapter instead.
  presence?: Presence;
  // server.ts opens the database and swaps it in once the refresh job has one.
  geo?: GeoReader;
  // The nudge that wakes a realtime stream, and the set that stops an SSO token
  // being exchanged twice. Redis when the environment names one, this process
  // otherwise; handed in by a test that wants to drive them.
  bus?: Bus;
  once?: OnceOnly;
  // Injected so a test can state what time it is, the way the store's is.
  now?: () => number;
  // How a visitor's address is resolved. The environment decides it for a real
  // instance; a test hands one in to drive a mode this process did not boot in.
  ip?: ClientIpOptions;
}

function wantsHtml(accept: string | undefined): boolean {
  return accept !== undefined && accept.includes('text/html');
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: env.TRUST_PROXY.length === 0 ? false : env.TRUST_PROXY,
  });

  const now = options.now ?? ((): number => Date.now());
  const store =
    options.store ??
    createMemoryStore([], options.presence === undefined ? {} : { presence: options.presence });
  const session = resolveSessionSecret();
  if (session.generated) {
    app.log.warn(
      'SESSION_SECRET is not set, so one was generated: every restart signs everybody out and two processes will not share a session',
    );
  }
  const bus = options.bus ?? openBus().bus;
  const once = options.once ?? openOnce(now).once;
  const ipOptions: ClientIpOptions = options.ip ?? {
    trustProxy: env.TRUST_PROXY,
    realIpHeader: env.REAL_IP_HEADER,
    proxySecret: env.CHOKH_PROXY_SECRET,
  };

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

  // The session is an httpOnly cookie, so the request needs parsed cookies and
  // the reply needs to be able to set one. Nothing here signs with the plugin's
  // own secret: the cookie carries its own signature, made in auth.service.ts.
  await app.register(fastifyCookie);
  registerAuthDecorations(app);

  await registerHealthRoutes(app);

  await registerCollectRoutes(
    app,
    {
      store,
      geo: options.geo ?? emptyReader,
      visitorIds: createVisitorIdSource(),
      ipLimit: createWindowCounter(MINUTE_MS),
      siteLimit: createWindowCounter(MINUTE_MS),
      visitorRate: createWindowCounter(MINUTE_MS),
      dedupe: createDedupe(),
      limits: { perIp: env.COLLECT_RATE_LIMIT_IP, perSite: env.COLLECT_RATE_LIMIT_SITE },
      bus,
      now,
    },
    ipOptions,
  );

  const apiDeps: ApiDeps = {
    store,
    session: createSessionCodec(session.secret, env.SESSION_TTL_HOURS * HOUR_MS),
    bus,
    once,
    authLimit: createWindowCounter(MINUTE_MS),
    limits: { authAttempts: env.AUTH_RATE_LIMIT },
    cookie: { secure: cookieSecure() },
    sso: { secret: env.SSO_SECRET, maxAgeSeconds: env.SSO_MAX_AGE_SECONDS },
    now,
  };
  await registerApiRoutes(app, apiDeps, ipOptions);

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
