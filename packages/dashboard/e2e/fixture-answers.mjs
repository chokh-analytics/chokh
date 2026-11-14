// What the frozen fixture answers for each address under /api, as data: a
// status and a body in the API's envelope. No Node in it, so two things use
// it: the fixture server the screenshots are taken against
// (fixture-server.mjs), and the demo, where it answers in the visitor's own
// browser and no server is involved at all (src/demo/).
//
// Every answer is the contract's envelope. A fixture that invents a shape
// proves the dashboard against a server that does not exist.
import {
  AUDIT,
  ENGAGEMENT,
  EVENTS,
  FUNNELS,
  GOALS,
  INVITATION_PREVIEW,
  ME,
  SITE,
  SITE_INVITATIONS,
  SITE_MEMBERS,
  TEAM_INVITATIONS,
  TEAM_MEMBERS,
  PROFILE,
  REALTIME,
  aggregateFor,
  breakdownFor,
  funnelStats,
  goalStats,
  journeys,
  properties,
  timeseries,
} from './fixture-data.mjs';
import { DEMO_SITE } from './demo-site.mjs';

// What a goal read says about itself: raw rows, back as far as the site keeps
// them.
const RAW = { retentionDays: 180, rawOnly: true };

function ok(data, meta) {
  return { status: 200, body: meta === undefined ? { success: true, data } : { success: true, data, meta } };
}

function refuse(status, code, message) {
  return { status, body: { success: false, error: { code, message } } };
}

// A licence that names every feature, for the demo: every page then shows
// what a licensed install shows, and the demo's banner says which are paid.
const LICENSED = {
  licensed: true,
  plan: 'pro',
  licensee: DEMO_SITE.name,
  expiresAt: null,
  features: ['*'],
};

// The first frame of the realtime stream, held open after it.
export const REALTIME_FRAME = { success: true, data: REALTIME };

// The answer for a GET of `path` with `params`. `licensed` answers as an
// install with a key; `invite` as a page an invitation link opened, whose
// visitor is nobody yet.
export function answer(path, params, { licensed = false, invite = false } = {}) {
  if (path === '/health') {
    return ok({ status: 'ok' });
  }
  if (path === '/api/me') {
    return invite ? refuse(401, 'UNAUTHENTICATED', 'Sign in first') : ok(ME);
  }
  if (path === '/api/license' && licensed) {
    return ok(LICENSED);
  }
  // Who can reach the site, who is waiting, and the record of who looked at
  // whom (AN-TEAM01), for the Team, Audit log and invitation pictures.
  if (path === '/api/teams/default/members') {
    return ok(TEAM_MEMBERS);
  }
  if (path === `/api/sites/${SITE.id}/members`) {
    return ok(SITE_MEMBERS, { siteId: SITE.id });
  }
  if (path === '/api/teams/default/invitations') {
    return ok(TEAM_INVITATIONS);
  }
  if (path === `/api/sites/${SITE.id}/invitations`) {
    return ok(SITE_INVITATIONS);
  }
  if (path.endsWith('/audit')) {
    return ok(AUDIT, { identity: true, limit: 50 });
  }
  if (path === '/api/invitations/lookup') {
    return ok(INVITATION_PREVIEW);
  }
  // The public share (AN-RPT01) of the demo site, one token. Its report
  // routes end the way a site's do, so the handlers below answer them.
  if (path === '/api/share/tok_demo') {
    return ok({ site: { name: DEMO_SITE.name, timezone: 'Asia/Dhaka' }, protected: false, unlocked: true });
  }
  // The paid pages, on a licensed answer: nothing set up yet, which is what
  // a new install shows, and no single sign-on configured.
  if (licensed && path.endsWith('/ee/alerts')) {
    return ok({ alerts: [] }, { siteId: SITE.id });
  }
  if (licensed && path.endsWith('/ee/digests')) {
    return ok({ digests: [] }, { siteId: SITE.id });
  }
  if (path === '/api/ee/oidc') {
    return ok({ enabled: false });
  }
  if (path.endsWith('/annotations')) {
    return ok({ annotations: [] });
  }
  if (path.endsWith('/stats/aggregate')) {
    const goal = params.get('goal');
    return ok(aggregateFor(goal), goal === null ? undefined : RAW);
  }
  if (path.endsWith('/stats/timeseries')) {
    return ok(timeseries(params.get('interval') ?? 'day'));
  }
  if (path.endsWith('/stats/breakdown')) {
    const goal = params.get('goal');
    return ok(
      breakdownFor(params.get('dim') ?? 'page', Number(params.get('limit') ?? 10), goal),
      goal === null ? undefined : RAW,
    );
  }
  if (path.endsWith('/stats/goals')) {
    return ok(goalStats(), RAW);
  }
  if (path.endsWith('/stats/events')) {
    return ok(EVENTS, RAW);
  }
  if (path.endsWith('/stats/properties')) {
    return ok(properties(params.get('event') ?? '', params.get('property')), RAW);
  }
  if (path.endsWith('/stats/journeys')) {
    return ok(journeys(Number(params.get('branches') ?? 5)), RAW);
  }
  if (path.endsWith('/stats/funnel')) {
    return ok(funnelStats(params.get('funnel')), { ...RAW, funnel: params.get('funnel') });
  }
  if (path.endsWith('/funnels')) {
    return ok({ funnels: FUNNELS }, { siteId: SITE.id, max: 50, maxSteps: 8 });
  }
  if (path.endsWith('/goals')) {
    return ok({ goals: GOALS }, { siteId: SITE.id, max: 50 });
  }
  if (path.endsWith('/stats/engagement')) {
    return ok(ENGAGEMENT, { retentionDays: 180 });
  }
  if (path.endsWith('/realtime')) {
    // No identity, which is the default an install has: the address column is
    // absent and the page says which permission would show it.
    return ok(REALTIME, { identity: false });
  }
  if (path.includes('/visitors/')) {
    return ok(PROFILE, { identity: false });
  }
  if (path.includes('/users/')) {
    return refuse(403, 'FORBIDDEN', 'This lookup names a person, so it needs the read:identity permission.');
  }
  return refuse(404, 'NOT_FOUND', `Nothing answers ${path}`);
}
