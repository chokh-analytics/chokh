import type { ClientHints } from '@chokh/geo';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { clientIp, type ClientIpOptions } from '../lib/client-ip.js';
import { fail } from '../lib/envelope.js';
import { batchSchema } from '../schemas/collect.schema.js';
import { collect, type CollectDeps } from '../services/collect.service.js';

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readHints(request: FastifyRequest): ClientHints {
  const hints: ClientHints = {};
  const ua = header(request, 'sec-ch-ua');
  const fullVersionList = header(request, 'sec-ch-ua-full-version-list');
  const mobile = header(request, 'sec-ch-ua-mobile');
  const platform = header(request, 'sec-ch-ua-platform');
  const platformVersion = header(request, 'sec-ch-ua-platform-version');
  const model = header(request, 'sec-ch-ua-model');
  if (ua !== undefined) hints.ua = ua;
  if (fullVersionList !== undefined) hints.fullVersionList = fullVersionList;
  if (mobile !== undefined) hints.mobile = mobile;
  if (platform !== undefined) hints.platform = platform;
  if (platformVersion !== undefined) hints.platformVersion = platformVersion;
  if (model !== undefined) hints.model = model;
  return hints;
}

export function createCollectController(
  deps: CollectDeps,
  ipOptions: ClientIpOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async function collectController(request, reply) {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BATCH', 'The batch did not validate', parsed.error.issues));
    }

    const result = await collect(deps, {
      batch: parsed.data,
      ip: clientIp(
        {
          ip: request.ip,
          peer: request.socket.remoteAddress,
          header: request.headers[ipOptions.realIpHeader],
        },
        ipOptions,
      ),
      userAgent: header(request, 'user-agent') ?? '',
      origin: header(request, 'origin') ?? header(request, 'referer'),
      hints: readHints(request),
    });

    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }

    if (result.identity === 'refused') {
      // The batch is still collected, anonymously. A site owner who turned
      // unsigned identifies off needs to see that a page is still trying, so
      // this is the one place it shows.
      request.log.warn({ siteId: parsed.data.siteId }, 'identify refused, batch collected anonymously');
    }

    // A beacon cannot read a response, so the ticket asks for 202 and no body.
    // Every failure still answers with the envelope.
    return reply.code(202).send();
  };
}
