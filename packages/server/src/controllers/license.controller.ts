import type { FastifyReply, FastifyRequest } from 'fastify';

import { ok } from '../lib/envelope.js';
import type { LicenseStatusProvider } from '../plugins/extensions.js';

// What this install may run, for the dashboard to draw.
//
// Core answers it, from whatever provider was resolved at boot: the extension's
// when packages/ee is there, and "no licence" when it is not. That is what lets
// a core-only build draw the same "part of Chokh Pro" label on a feature it
// does not have, which is the rule the dashboard is held to: a gated feature is
// described, never simulated and never hidden.
//
// The route needs a session. The licensee's name and the expiry date are not
// for strangers: they say who runs this install and when they last paid, and
// neither is anybody's business from the outside. Nothing here ever returns the
// key itself, with or without a session.
export function createLicenseController(license: LicenseStatusProvider) {
  return function licenseController(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(ok(license()));
  };
}
