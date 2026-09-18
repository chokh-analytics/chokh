import type { FastifyReply, FastifyRequest } from 'fastify';

import { ok } from '../lib/envelope.js';
import { getHealth } from '../services/health.service.js';

export async function healthController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return reply.send(ok(getHealth()));
}
