import type { RouteRule } from '@chokh/server';

import { ALERTS_FEATURE } from '../alerts/conditions.js';
import { DIGESTS_FEATURE } from '../digests/period.js';
import { PING_FEATURE } from './ee.routes.js';

// Every paid route and what it asks of a caller, as data: the scope on the
// site first, then the feature the install has to be licensed for. The same
// statement ee.routes.ts makes where it registers each one, made a second
// time so a test can walk it (packages/server/src/routes/route-table.ts says
// why). A route added here without a row fails that test, and so does a route
// whose licence hook came off: on an install with no key every caller who
// passed the scope check has to be told LICENSE_REQUIRED and nothing else.

const SITE = '/api/sites/:siteId/ee';

function paid(
  method: RouteRule['method'],
  url: string,
  scope: 'read:stats' | 'admin',
  feature: string,
): RouteRule {
  return { method, url, needs: { kind: 'site', scope }, feature };
}

export const EE_ROUTES: readonly RouteRule[] = [
  paid('GET', `${SITE}/ping`, 'read:stats', PING_FEATURE),

  paid('GET', `${SITE}/alerts`, 'read:stats', ALERTS_FEATURE),
  paid('POST', `${SITE}/alerts`, 'admin', ALERTS_FEATURE),
  paid('DELETE', `${SITE}/alerts/:alertId`, 'admin', ALERTS_FEATURE),
  paid('POST', `${SITE}/alerts/:alertId/test`, 'admin', ALERTS_FEATURE),

  paid('GET', `${SITE}/digests`, 'read:stats', DIGESTS_FEATURE),
  paid('POST', `${SITE}/digests`, 'admin', DIGESTS_FEATURE),
  paid('DELETE', `${SITE}/digests/:digestId`, 'admin', DIGESTS_FEATURE),
  paid('POST', `${SITE}/digests/:digestId/send`, 'admin', DIGESTS_FEATURE),
];
