import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import { env } from './config/env.js';
import { fail } from './lib/envelope.js';
import { registerDashboard } from './plugins/dashboard.js';
import { registerHealthRoutes } from './routes/health.routes.js';

function wantsHtml(accept: string | undefined): boolean {
  return accept !== undefined && accept.includes('text/html');
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  await registerHealthRoutes(app);
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

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error({ err: error }, 'request failed');
    const status = error.statusCode ?? 500;
    // A plain Error thrown by a handler reaches here without a code, so the
    // type is wider than the framework's declaration admits.
    const rawCode: string | undefined = error.code;
    const code = status === 500 ? 'INTERNAL_ERROR' : (rawCode ?? 'REQUEST_ERROR');
    const message = status === 500 ? 'Internal server error' : error.message;
    return reply.code(status).send(fail(code, message));
  });

  return app;
}
