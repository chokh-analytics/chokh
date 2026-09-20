import type { FastifyInstance } from 'fastify';
import { ok, requireSiteScope, type ApiDeps } from '@chokh/server/dist/index.js';

import { requireLicense } from '../license/guard.js';
import type { LicenseState } from '../license/state.js';

// Every paid route, in one file, the way the core keeps its own in one file:
// the whole authorization model is readable in one place, and a route that
// forgot its gate is visible rather than buried.
//
// Two hooks on each, in this order and built at each registration. The scope
// hook first, so a caller with no session or no role on the site is refused for
// that and never told which paid feature lives at the path they guessed. The
// licence hook second, and a fresh one per route: a shared array would give
// every route the first one's feature name.

export const PING_FEATURE = 'ee.ping';

export async function registerEeRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  state: LicenseState,
): Promise<void> {
  const auth = { store: deps.store, session: deps.session, now: deps.now };

  // The frame's own health probe, and the feature AN-EE01 is verified against.
  //
  // It stays after the first real paid feature lands, because it is the one
  // route whose only job is to answer the question "is the gate working on this
  // install", and an operator who has just pasted a key in wants to ask that
  // without buying anything else first.
  app.get(
    '/api/sites/:siteId/ee/ping',
    { preHandler: [requireSiteScope(auth, 'read:stats'), requireLicense(state, PING_FEATURE)] },
    () => ok({ pong: true, feature: PING_FEATURE }),
  );
}
