import type { RouteDocGroup } from '@chokh/server';

import { createAlertSchema } from '../alerts/conditions.js';
import { createDigestSchema } from '../digests/period.js';
import { callbackSchema, inviteSchema } from '../oidc/oidc.routes.js';
import { createTeamSchema, moveSiteSchema } from '../teams/teams.routes.js';

// What the API reference says about each route of packages/ee, the way the
// core's route-docs.ts does for its own, held to EE_ROUTES by a test.

const SITE = '/api/sites/:siteId/ee';

export const EE_ROUTE_DOCS: readonly RouteDocGroup[] = [
  {
    group: 'Alerts (Chokh Pro)',
    routes: {
      [`GET ${SITE}/alerts`]: { summary: 'The site\'s alerts and where each one sends.' },
      [`POST ${SITE}/alerts`]: { summary: 'Creates an alert: a condition on a number, and the email, Telegram chat or webhook it goes to.', body: createAlertSchema },
      [`DELETE ${SITE}/alerts/:alertId`]: { summary: 'Deletes an alert.' },
      [`POST ${SITE}/alerts/:alertId/test`]: { summary: 'Sends an alert\'s message now, to check where it goes.' },
    },
  },
  {
    group: 'Digests (Chokh Pro)',
    routes: {
      [`GET ${SITE}/digests`]: { summary: 'The site\'s scheduled email digests.' },
      [`POST ${SITE}/digests`]: { summary: 'Schedules a digest by email, daily or weekly, with the same numbers in an attached PDF.', body: createDigestSchema },
      [`DELETE ${SITE}/digests/:digestId`]: { summary: 'Stops a digest.' },
      [`POST ${SITE}/digests/:digestId/send`]: { summary: 'Sends a digest now.' },
    },
  },
  {
    group: 'More than one team (Chokh Pro)',
    routes: {
      'POST /api/ee/teams': { summary: 'Creates a team, owned by whoever creates it.', body: createTeamSchema },
      'DELETE /api/ee/teams/:teamId': { summary: 'Deletes a team that holds no site.' },
      'PUT /api/ee/sites/:siteId/team': { summary: 'Moves a site to another team the caller owns.', body: moveSiteSchema },
    },
  },
  {
    group: 'Single sign-on (Chokh Pro)',
    routes: {
      'GET /api/ee/oidc': { summary: 'Whether single sign-on is on, for the sign-in page.' },
      'GET /api/ee/oidc/start': { summary: 'Sends the browser to the identity provider to sign in.' },
      'GET /api/ee/oidc/callback': { summary: 'Where the provider sends the browser back; signs the person in.', query: callbackSchema },
      'POST /api/ee/oidc/invite': { summary: 'Uses an invitation by signing in with the provider.', body: inviteSchema },
      'POST /api/ee/oidc/link': { summary: 'Connects the account signed in to an identity at the provider.' },
      'GET /api/ee/oidc/identity': { summary: 'Whether the account signed in is connected, and to what.' },
      'DELETE /api/ee/oidc/identity': { summary: 'Disconnects it, unless it is the account\'s only way in.' },
    },
  },
  {
    group: 'Checking a licence (Chokh Pro)',
    routes: {
      [`GET ${SITE}/ping`]: { summary: 'Answers only when the licence key covers paid features: a way to check a key works.' },
    },
  },
];
