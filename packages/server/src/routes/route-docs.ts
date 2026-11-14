import type { ZodTypeAny } from 'zod';

import {
  acceptInvitationSchema,
  createInvitationSchema,
  createKeySchema,
  createSiteSchema,
  loginSchema,
  lookupInvitationSchema,
  patchSiteSchema,
  registerSchema,
  removeMemberQuerySchema,
  renameTeamSchema,
  setMemberSchema,
  ssoBodySchema,
  ssoQuerySchema,
} from '../schemas/accounts.schema.js';
import { annotationRangeSchema, createAnnotationSchema } from '../schemas/annotations.schema.js';
import { auditQuerySchema } from '../schemas/audit.schema.js';
import { batchSchema } from '../schemas/collect.schema.js';
import { serverBatchSchema } from '../schemas/events.schema.js';
import { createFunnelSchema, funnelStatsQuerySchema, journeysQuerySchema } from '../schemas/funnels.schema.js';
import { createGoalSchema } from '../schemas/goals.schema.js';
import { peopleQuerySchema } from '../schemas/people.schema.js';
import {
  activityQuerySchema,
  attributionQuerySchema,
  cohortsQuerySchema,
  powerUsersQuerySchema,
} from '../schemas/retention.schema.js';
import { createSegmentSchema } from '../schemas/segments.schema.js';
import { putShareSchema, unlockShareSchema } from '../schemas/share.schema.js';
import { coverageQuerySchema, errorsQuerySchema, vitalsQuerySchema } from '../schemas/site-health.schema.js';
import { propertiesQuerySchema, statsQuerySchema } from '../schemas/stats.schema.js';

// What the API reference says about each route: one sentence, and the schema
// its controller reads its query and its body with. The docs site generates
// its reference (and an OpenAPI file) from this and the route table, and a
// test holds the two to each other, so a route cannot be added without a
// line here. Who may call a route is the route table's to say, not this.

export interface RouteDoc {
  summary: string;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
}

export interface RouteDocGroup {
  group: string;
  routes: Readonly<Record<string, RouteDoc>>;
}

const S = '/api/sites/:siteId';
const SH = '/api/share/:token';

export const CORE_ROUTE_DOCS: readonly RouteDocGroup[] = [
  {
    group: 'Collecting',
    routes: {
      'POST /api/collect': { summary: 'What the tracker sends: a batch of pageviews and events from one page, read as JSON whatever its content type says.', body: batchSchema },
      [`POST ${S}/events`]: { summary: 'Events and identifies from your own server, with a key carrying write:events.', body: serverBatchSchema },
      'GET /health': { summary: 'Whether the process is up, for a load balancer or a container check.' },
    },
  },
  {
    group: 'Signing in',
    routes: {
      'POST /api/auth/register': { summary: 'The first account of an install registers itself and owns it; after that, an owner creates accounts.', body: registerSchema },
      'POST /api/auth/login': { summary: 'Signs in with an address and a password and sets the session cookie.', body: loginSchema },
      'POST /api/auth/logout': { summary: 'Ends the session this request carries.' },
      'POST /api/sso': { summary: 'Exchanges a token another application signed for a session, for that application\'s server.', body: ssoBodySchema },
      'GET /api/sso': { summary: 'The same exchange for a person following a link: sets the cookie and redirects to `next`.', query: ssoQuerySchema },
      'GET /api/me': { summary: 'Who is asking: the account or the key, and every site it can read with its role and scopes.' },
      'GET /api/license': { summary: 'What this install may run: the licence\'s holder, its features and its expiry, or that there is none.' },
    },
  },
  {
    group: 'Sites',
    routes: {
      'GET /api/sites': { summary: 'The sites the caller can read.' },
      'POST /api/sites': { summary: 'Creates a site, with its id, name, domains and settings. Its identify secret is in the answer, once.', body: createSiteSchema },
      [`GET ${S}`]: { summary: 'One site and its settings.' },
      [`PATCH ${S}`]: { summary: 'Changes a site\'s name, domains or settings.', body: patchSiteSchema },
      [`POST ${S}/identify-secret/rotate`]: { summary: 'Replaces the site\'s identify secret; the new one is in the answer, once.' },
    },
  },
  {
    group: 'Keys',
    routes: {
      [`GET ${S}/keys`]: { summary: 'The site\'s keys, without their tokens.' },
      [`POST ${S}/keys`]: { summary: 'Creates a key with the scopes named; its token is in the answer, once.', body: createKeySchema },
      [`DELETE ${S}/keys/:keyId`]: { summary: 'Revokes a key.' },
    },
  },
  {
    group: 'Reports',
    routes: {
      [`GET ${S}/stats/aggregate`]: { summary: 'The headline numbers for a range: visitors, visits, pageviews, bounce rate, visit duration, with a comparison when asked.', query: statsQuerySchema },
      [`GET ${S}/stats/timeseries`]: { summary: 'The same numbers by minute, hour, day, week or month.', query: statsQuerySchema },
      [`GET ${S}/stats/breakdown`]: { summary: 'One dimension\'s rows (pages, sources, countries, devices and the rest), with their numbers.', query: statsQuerySchema },
      [`GET ${S}/stats/engagement`]: { summary: 'Time on page and scroll depth by page.', query: statsQuerySchema },
      [`GET ${S}/export.csv`]: { summary: 'Any report as a CSV file.', query: statsQuerySchema },
      [`GET ${S}/stats/events`]: { summary: 'Custom events and how often each happened.', query: statsQuerySchema },
      [`GET ${S}/stats/properties`]: { summary: 'One event\'s properties and their values.', query: propertiesQuerySchema },
      [`GET ${S}/stats/goals`]: { summary: 'Each goal\'s conversions and conversion rate.', query: statsQuerySchema },
      [`GET ${S}/stats/funnel`]: { summary: 'A saved funnel: how many reached each step, and where they dropped off.', query: funnelStatsQuerySchema },
      [`GET ${S}/stats/journeys`]: { summary: 'The paths visits took from the page they came in on.', query: journeysQuerySchema },
      [`GET ${S}/stats/cohorts`]: { summary: 'Retention cohorts: of the visitors first seen in a week or month, how many came back in each one after.', query: cohortsQuerySchema },
      [`GET ${S}/stats/activity`]: { summary: 'Daily, weekly and monthly active visitors, and stickiness.', query: activityQuerySchema },
      [`GET ${S}/stats/attribution`]: { summary: 'First touch against last touch for one goal: what first brought each converting visitor, and what brought the visit they converted in.', query: attributionQuerySchema },
      [`GET ${S}/stats/power-users`]: { summary: 'The most active people of the range, as rows of the people directory; their names only for a caller with read:identity.', query: powerUsersQuerySchema },
      [`GET ${S}/stats/vitals`]: { summary: 'Core Web Vitals by page, at the 75th percentile.', query: vitalsQuerySchema },
      [`GET ${S}/stats/errors`]: { summary: 'JavaScript errors, grouped by message and place.', query: errorsQuerySchema },
      [`GET ${S}/stats/coverage`]: { summary: 'Of the people the site\'s server named, the share no browser row carries: an estimate of how many block or decline the tracker.', query: coverageQuerySchema },
    },
  },
  {
    group: 'Realtime',
    routes: {
      [`GET ${S}/realtime`]: { summary: 'Who is on the site now, and on which page.' },
      [`GET ${S}/realtime/stream`]: { summary: 'The same, pushed as server-sent events when it changes.' },
    },
  },
  {
    group: 'People',
    routes: {
      [`GET ${S}/people`]: { summary: 'Everybody the site has seen, with search and an identified-only switch.', query: peopleQuerySchema },
      [`GET ${S}/visitors/:visitorId`]: { summary: 'One visitor\'s visits and events.' },
      [`GET ${S}/users/:userId`]: { summary: 'One identified person\'s visits, events and traits.' },
      [`GET ${S}/users/:userId/presence`]: { summary: 'Whether that person is on the site now.' },
    },
  },
  {
    group: 'Goals, funnels, segments and annotations',
    routes: {
      [`GET ${S}/goals`]: { summary: 'The site\'s goals.' },
      [`POST ${S}/goals`]: { summary: 'Creates a goal: a page or an event.', body: createGoalSchema },
      [`DELETE ${S}/goals/:goalId`]: { summary: 'Deletes a goal.' },
      [`GET ${S}/funnels`]: { summary: 'The site\'s funnels.' },
      [`POST ${S}/funnels`]: { summary: 'Creates a funnel from its steps.', body: createFunnelSchema },
      [`DELETE ${S}/funnels/:funnelId`]: { summary: 'Deletes a funnel.' },
      [`GET ${S}/segments`]: { summary: 'The site\'s saved segments.' },
      [`POST ${S}/segments`]: { summary: 'Saves a list of filters under a name.', body: createSegmentSchema },
      [`DELETE ${S}/segments/:segmentId`]: { summary: 'Deletes a segment.' },
      [`GET ${S}/annotations`]: { summary: 'The marks drawn on the chart in a range.', query: annotationRangeSchema },
      [`POST ${S}/annotations`]: { summary: 'Adds a mark: a deploy, a campaign, an outage or a note.', body: createAnnotationSchema },
      [`DELETE ${S}/annotations/:annotationId`]: { summary: 'Deletes a mark.' },
    },
  },
  {
    group: 'Sharing',
    routes: {
      [`PUT ${S}/share`]: { summary: 'Turns on the public share link, with an optional password, or changes it.', body: putShareSchema },
      [`DELETE ${S}/share`]: { summary: 'Turns the share link off.' },
      [`GET ${SH}`]: { summary: 'What a share link shows: the site\'s name and whether a password is asked for.' },
      [`POST ${SH}/unlock`]: { summary: 'Opens a share that has a password.', body: unlockShareSchema },
      [`GET ${SH}/stats/aggregate`]: { summary: 'The headline numbers, through a share link.', query: statsQuerySchema },
      [`GET ${SH}/stats/timeseries`]: { summary: 'The chart, through a share link.', query: statsQuerySchema },
      [`GET ${SH}/stats/breakdown`]: { summary: 'One dimension\'s rows, through a share link.', query: statsQuerySchema },
      [`GET ${SH}/stats/goals`]: { summary: 'The goals, through a share link.', query: statsQuerySchema },
      [`GET ${SH}/annotations`]: { summary: 'The chart\'s marks, through a share link.', query: annotationRangeSchema },
      [`GET ${SH}/widget.svg`]: { summary: 'A badge of visitors or pageviews for today, 7 or 30 days, to put on a page.' },
    },
  },
  {
    group: 'Teams and members',
    routes: {
      'GET /api/teams/:teamId/members': { summary: 'A team\'s members and their roles.' },
      'PUT /api/teams/:teamId/members/:userId': { summary: 'Gives somebody a role in the team, or changes it.', body: setMemberSchema },
      'DELETE /api/teams/:teamId/members/:userId': { summary: 'Removes somebody from the team.', query: removeMemberQuerySchema },
      'PATCH /api/teams/:teamId': { summary: 'Renames a team.', body: renameTeamSchema },
      [`GET ${S}/members`]: { summary: 'Who has a role on this one site.' },
      [`PUT ${S}/members/:userId`]: { summary: 'Gives somebody a role on this one site, or changes it.', body: setMemberSchema },
      [`DELETE ${S}/members/:userId`]: { summary: 'Removes somebody\'s role on this site.', query: removeMemberQuerySchema },
    },
  },
  {
    group: 'Invitations',
    routes: {
      'GET /api/teams/:teamId/invitations': { summary: 'The team\'s invitations still waiting.' },
      'POST /api/teams/:teamId/invitations': { summary: 'Invites somebody to the team; the link is in the answer, once.', body: createInvitationSchema },
      'DELETE /api/teams/:teamId/invitations/:invitationId': { summary: 'Takes an invitation back.' },
      [`GET ${S}/invitations`]: { summary: 'The site\'s invitations still waiting.' },
      [`POST ${S}/invitations`]: { summary: 'Invites somebody to this one site; the link is in the answer, once.', body: createInvitationSchema },
      [`DELETE ${S}/invitations/:invitationId`]: { summary: 'Takes an invitation back.' },
      'POST /api/invitations/lookup': { summary: 'What an invitation is for, for the page its link opens.', body: lookupInvitationSchema },
      'POST /api/invitations/accept': { summary: 'Uses an invitation: by the account signed in, or by a new one with a password.', body: acceptInvitationSchema },
    },
  },
  {
    group: 'The audit log',
    routes: {
      'GET /api/teams/:teamId/audit': { summary: 'The team\'s log of who gave whom what, and who read identities, newest first.', query: auditQuerySchema },
      [`GET ${S}/audit`]: { summary: 'The same log for one site.', query: auditQuerySchema },
    },
  },
];
