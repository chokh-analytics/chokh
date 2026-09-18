import type { FastifyInstance } from 'fastify';

import {
  createLoginController,
  createLogoutController,
  createMeController,
  createRegisterController,
  createSetMemberController,
} from '../controllers/accounts.controller.js';
import { createServerEventsController } from '../controllers/events.controller.js';
import {
  createUserController,
  createUserPresenceController,
  createVisitorController,
} from '../controllers/people.controller.js';
import {
  createRealtimeController,
  createRealtimeStreamController,
} from '../controllers/realtime.controller.js';
import {
  createCreateKeyController,
  createCreateSiteController,
  createDeleteKeyController,
  createGetSiteController,
  createListKeysController,
  createListSitesController,
  createPatchSiteController,
  createRotateSecretController,
} from '../controllers/sites.controller.js';
import {
  createAggregateController,
  createBreakdownController,
  createExportController,
  createTimeseriesController,
} from '../controllers/stats.controller.js';
import {
  createSsoGetController,
  createSsoPostController,
} from '../controllers/sso.controller.js';
import type { ApiDeps } from '../lib/api-deps.js';
import type { ClientIpOptions } from '../lib/client-ip.js';
import {
  attachPrincipal,
  limitAttempts,
  requirePrincipal,
  requireSiteScope,
} from '../plugins/auth.js';
import type { AuthDeps } from '../services/auth.service.js';

// Every route of the stats API, and the one hook each of them runs first.
//
// The whole authorization model is readable here, which is the point of putting
// them in one file: read:stats for the reports, read:identity for the two routes
// that name a person, write:events for what a backend sends, admin for keys and
// settings. A route with no hook is a route anybody may call, and there are four:
// registration (open only while there is nobody), login, and the two SSO forms,
// all four rate limited by address.
//
// There is deliberately no CORS. The dashboard is served by this same process, so
// it is same origin, and Progsity's backend calls this server to server and proxies
// the stream itself. Adding a permissive Access-Control-Allow-Origin here would
// make every browser on the internet able to read a site's numbers with a stolen
// cookie, so if a cross origin consumer ever appears it gets an allowlist and a
// reason written down, never a wildcard.

export async function registerApiRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  ipOptions: ClientIpOptions,
): Promise<void> {
  const auth: AuthDeps = { store: deps.store, session: deps.session, now: deps.now };
  const attempts = limitAttempts(deps.limits.authAttempts, deps.authLimit, ipOptions, deps.now);
  const signedIn = requirePrincipal(auth);
  const scope = (name: Parameters<typeof requireSiteScope>[1]) => requireSiteScope(auth, name);

  // Signing in. Open by necessity, limited by address.
  app.post(
    '/api/auth/register',
    { preHandler: [attempts, attachPrincipal(auth)] },
    createRegisterController(deps),
  );
  app.post('/api/auth/login', { preHandler: attempts }, createLoginController(deps));
  app.post('/api/auth/logout', { preHandler: signedIn }, createLogoutController(deps));
  app.get('/api/me', { preHandler: signedIn }, createMeController(deps));
  app.post('/api/sso', { preHandler: attempts }, createSsoPostController(deps));
  app.get('/api/sso', { preHandler: attempts }, createSsoGetController(deps));

  // Teams. One route; AN-TEAM01 owns the rest.
  app.put(
    '/api/teams/:teamId/members/:userId',
    { preHandler: signedIn },
    createSetMemberController(deps),
  );

  // Sites. Listing and creating are about the caller rather than about one site, so
  // they take the principal hook; everything under /:siteId takes the scope hook,
  // which is also what reads the site.
  app.get('/api/sites', { preHandler: signedIn }, createListSitesController(deps));
  app.post('/api/sites', { preHandler: signedIn }, createCreateSiteController(deps));
  app.get('/api/sites/:siteId', { preHandler: scope('read:stats') }, createGetSiteController());
  app.patch('/api/sites/:siteId', { preHandler: scope('admin') }, createPatchSiteController(deps));
  app.post(
    '/api/sites/:siteId/identify-secret/rotate',
    { preHandler: scope('admin') },
    createRotateSecretController(deps),
  );

  // Keys. admin, because a key is a way to hand out access.
  app.get('/api/sites/:siteId/keys', { preHandler: scope('admin') }, createListKeysController(deps));
  app.post(
    '/api/sites/:siteId/keys',
    { preHandler: scope('admin') },
    createCreateKeyController(deps),
  );
  app.delete(
    '/api/sites/:siteId/keys/:keyId',
    { preHandler: scope('admin') },
    createDeleteKeyController(deps),
  );

  // The reports.
  app.get(
    '/api/sites/:siteId/stats/aggregate',
    { preHandler: scope('read:stats') },
    createAggregateController(deps),
  );
  app.get(
    '/api/sites/:siteId/stats/timeseries',
    { preHandler: scope('read:stats') },
    createTimeseriesController(deps),
  );
  app.get(
    '/api/sites/:siteId/stats/breakdown',
    { preHandler: scope('read:stats') },
    createBreakdownController(deps),
  );
  app.get(
    '/api/sites/:siteId/export.csv',
    { preHandler: scope('read:stats') },
    createExportController(deps),
  );

  // Who is here now.
  app.get(
    '/api/sites/:siteId/realtime',
    { preHandler: scope('read:stats') },
    createRealtimeController(deps),
  );
  app.get(
    '/api/sites/:siteId/realtime/stream',
    { preHandler: scope('read:stats') },
    createRealtimeStreamController(deps),
  );

  // People. The visitor route strips what the caller may not see; the two user
  // routes need read:identity to be reached at all.
  app.get(
    '/api/sites/:siteId/visitors/:visitorId',
    { preHandler: scope('read:stats') },
    createVisitorController(deps),
  );
  app.get(
    '/api/sites/:siteId/users/:userId',
    { preHandler: scope('read:identity') },
    createUserController(deps),
  );
  app.get(
    '/api/sites/:siteId/users/:userId/presence',
    { preHandler: scope('read:identity') },
    createUserPresenceController(deps),
  );

  // What a backend sends.
  app.post(
    '/api/sites/:siteId/events',
    { preHandler: scope('write:events') },
    createServerEventsController(deps),
  );
}
