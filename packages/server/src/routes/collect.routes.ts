import type { FastifyInstance } from 'fastify';

import { createCollectController } from '../controllers/collect.controller.js';
import type { ClientIpOptions } from '../lib/client-ip.js';
import type { CollectDeps } from '../services/collect.service.js';

export async function registerCollectRoutes(
  app: FastifyInstance,
  deps: CollectDeps,
  ipOptions: ClientIpOptions,
): Promise<void> {
  app.post('/api/collect', createCollectController(deps, ipOptions));
}
