import type { RouteRule } from '@chokh/server';

import { ALERTS_FEATURE } from '../alerts/conditions.js';
import { DIGESTS_FEATURE } from '../digests/period.js';
import { OIDC_FEATURE } from '../oidc/oidc.routes.js';
import { TEAMS_FEATURE } from '../teams/teams.routes.js';
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

  // More than one team. Not a scope on a site: a person who owns a team, said
  // three ways. Making one asks for an owner of any team; deleting one, for an
  // owner of the team in the path; moving a site, for an owner of the team the
  // site is in (and, past the licence, of the team it goes to, which the walk
  // names as the same one so that the first check is the one it meets).
  {
    method: 'POST',
    url: '/api/ee/teams',
    needs: { kind: 'anyTeamOwner' },
    feature: TEAMS_FEATURE,
    body: ({ serial }) => ({ name: `Probe ${serial}` }),
  },
  {
    method: 'DELETE',
    url: '/api/ee/teams/:teamId',
    needs: { kind: 'teamOwner' },
    feature: TEAMS_FEATURE,
  },
  {
    method: 'PUT',
    url: '/api/ee/sites/:siteId/team',
    needs: { kind: 'teamOwner' },
    feature: TEAMS_FEATURE,
    body: ({ params }) => ({ teamId: params['teamId'] }),
  },

  // Signing in through an identity provider. Four of these are open to
  // anybody, because whoever uses them is not signed in yet: they answer that
  // the feature is off where it is, which is a fact about the install and not
  // a refusal of the caller. The callback is where a browser arrives from the
  // provider, another site, by design; what protects it is the sealed cookie
  // of the flow that browser began, and a case holds that. The one that uses
  // an invitation begins a sign-in from what is in its body, so it is held to
  // coming from this dashboard like the core's three.
  { method: 'GET', url: '/api/ee/oidc', needs: { kind: 'public' }, feature: OIDC_FEATURE },
  { method: 'GET', url: '/api/ee/oidc/start', needs: { kind: 'public' }, feature: OIDC_FEATURE },
  {
    method: 'GET',
    url: '/api/ee/oidc/callback',
    needs: { kind: 'public' },
    feature: OIDC_FEATURE,
    crossSite: true,
  },
  {
    method: 'POST',
    url: '/api/ee/oidc/invite',
    needs: { kind: 'public' },
    feature: OIDC_FEATURE,
    startsSession: true,
    body: () => ({ token: 'chi_a-token-nothing-answers-to-0000000000' }),
  },
  // The three a signed-in person uses about their own account. A person, and
  // never a key.
  { method: 'POST', url: '/api/ee/oidc/link', needs: { kind: 'person' }, feature: OIDC_FEATURE },
  { method: 'GET', url: '/api/ee/oidc/identity', needs: { kind: 'person' }, feature: OIDC_FEATURE },
  { method: 'DELETE', url: '/api/ee/oidc/identity', needs: { kind: 'person' }, feature: OIDC_FEATURE },
];
