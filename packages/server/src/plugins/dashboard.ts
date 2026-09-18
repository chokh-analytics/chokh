// Serves the built dashboard from the same process as the collector, so one
// image is a complete install. When the dashboard has not been built the server
// still starts and the API still answers.
import { existsSync } from 'node:fs';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import { resolveDashboardDir } from '../config/env.js';

export async function registerDashboard(app: FastifyInstance): Promise<string | null> {
  const root = resolveDashboardDir();
  if (!existsSync(root)) {
    app.log.warn({ root }, 'dashboard build not found, static hosting is off');
    return null;
  }

  await app.register(fastifyStatic, {
    root,
    index: ['index.html'],
  });

  return root;
}
