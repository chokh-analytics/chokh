// The install the smoke test, the accessibility audit and the screenshots all
// look at.
//
// Fixed numbers rather than a seeded database, for the same reason the tracker
// suite serves its own fixture: what is being proved here is that the pages
// render, that the keys work and that the markup is sound, and none of that is
// a fact about MongoDB. A fixture also makes the screenshots reproducible,
// which matters more than it sounds: a README picture that changes every time
// it is taken cannot be reviewed.
//
// The shape of every answer is the API contract's, envelope included, because a
// fixture that answers a shape the server never sends proves the dashboard
// against a server that does not exist.

import {
  VITAL_METRICS,
  activityPlan,
  addCohortCell,
  cohortPlan,
  finishActivity,
  finishAttribution,
  finishCohorts,
  finishJourneys,
  foldCoverage,
  foldErrors,
  foldVitals,
  journeyPath,
  journeyStepCounts,
  powerMinDays,
  topJourneyPages,
  vitalBucket,
} from '@chokh/store';

import { DEMO_SITE } from './demo-site.mjs';

// A Friday, so the week in the charts has a shape rather than a plateau.
export const NOW = Date.UTC(2026, 8, 18, 9, 30, 0);

export const SITE = {
  id: DEMO_SITE.id,
  name: DEMO_SITE.name,
  domains: [DEMO_SITE.domain],
  teamId: 'default',
  settings: {
    ipMode: 'anonymized',
    visitorIdMode: 'persistent',
    botFilter: true,
    retentionDays: 180,
    timezone: 'Asia/Dhaka',
    allowUnsignedIdentify: false,
    // JavaScript errors are collected, with their stacks, so Health has its
    // errors to show (AN-VIT01).
    errorCapture: true,
    errorStacks: true,
    excludeIps: [],
    excludePaths: [],
    excludeQueryParams: [],
    routeGroups: [],
  },
};

const OWNER_SCOPES = ['admin', 'read:identity', 'read:stats', 'write:events'];

export const ME = {
  actor: { kind: 'session', id: 'u_demo' },
  user: { id: 'u_demo', email: DEMO_SITE.owner.email, name: DEMO_SITE.owner.name },
  // What this person may do on each site, as GET /api/me answers it.
  sites: [
    { ...SITE, scopes: OWNER_SCOPES, role: 'owner' },
    {
      ...SITE,
      id: 's_docs',
      name: 'Chokh docs',
      domains: ['docs.chokh.test'],
      scopes: OWNER_SCOPES,
      role: 'owner',
    },
  ],
  teams: [{ id: 'default', name: DEMO_SITE.name, role: 'owner' }],
};

// Who can reach the site (AN-TEAM01), for the Team page's picture: an owner,
// two colleagues, somebody another application signs in, a client let in to
// this one site, and two invitations, one of which would no longer work.
const DAY = 86_400_000;

export const TEAM_MEMBERS = {
  team: { id: 'default', name: DEMO_SITE.name },
  members: [
    { userId: 'u_demo', email: DEMO_SITE.owner.email, name: DEMO_SITE.owner.name, role: 'owner', identity: true, managed: false },
    { userId: 'u_ada', email: 'ada@quillmoor.example', name: 'Ada Rahman', role: 'editor', identity: true, managed: false },
    { userId: 'u_grace', email: 'grace@quillmoor.example', name: 'Grace Chowdhury', role: 'viewer', identity: false, managed: false },
    { userId: 'sso_staff_7', email: 'support@quillmoor.example', name: 'Support desk', role: 'viewer', identity: false, managed: true },
  ],
};

export const SITE_MEMBERS = {
  members: [
    { userId: 'u_client', email: 'marketing@client.test', name: 'A client', role: 'viewer', identity: false, managed: false },
  ],
};

function invitation(id, email, scope, role, over = {}) {
  return {
    id,
    email,
    scope,
    role,
    identity: false,
    invitedBy: 'u_demo',
    createdAt: NOW - DAY,
    expiresAt: NOW + 6 * DAY,
    state: 'pending',
    usable: true,
    ...over,
  };
}

export const TEAM_INVITATIONS = {
  invitations: [
    invitation('inv_1', 'new.colleague@quillmoor.example', { kind: 'team', id: 'default' }, 'editor'),
    invitation('inv_2', 'contractor@studio.test', { kind: 'team', id: 'default' }, 'viewer', {
      invitedBy: 'u_gone',
      usable: false,
    }),
  ],
};

export const SITE_INVITATIONS = { invitations: [] };

// What an invitation link answers whoever opens it.
export const INVITATION_PREVIEW = {
  invitation: {
    email: 'new.colleague@quillmoor.example',
    scope: { kind: 'team', id: 'default', name: DEMO_SITE.name },
    role: 'editor',
    identity: false,
    invitedBy: DEMO_SITE.owner.name,
    expiresAt: NOW + 6 * DAY,
    accountExists: false,
  },
};

function auditRow(id, minutesAgo, action, kind, route, over = {}) {
  return {
    id: String(id),
    siteId: 's_demo',
    ts: NOW - minutesAgo * 60_000,
    actor: { kind: 'session', id: 'u_demo', email: DEMO_SITE.owner.email },
    action,
    kind,
    route,
    fields: [],
    ...over,
  };
}

export const AUDIT = {
  rows: [
    auditRow(9, 4, 'read:identity', 'identity', 'GET /api/sites/:siteId/visitors/:visitorId', {
      actor: { kind: 'session', id: 'u_ada', email: 'ada@quillmoor.example' },
      target: 'v_abcdef0001',
      fields: ['ips', 'traits', 'userId'],
    }),
    auditRow(8, 22, 'read:identity', 'identity', 'GET /api/sites/:siteId/people', {
      actor: { kind: 'session', id: 'u_ada', email: 'ada@quillmoor.example' },
      target: 'rahim@example.test',
      fields: ['traits', 'userId'],
    }),
    auditRow(7, 61, 'read:audit', 'log', 'GET /api/sites/:siteId/audit', { fields: ['email', 'target'] }),
    auditRow(6, 95, 'member:set', 'access', 'PUT /api/sites/:siteId/members/:userId', {
      target: 'u_client',
      fields: ['role: none > viewer'],
    }),
    auditRow(5, 96, 'invite:accept', 'access', 'POST /api/invitations/accept', {
      actor: { kind: 'session', id: 'u_client', email: 'marketing@client.test' },
      target: 'u_client',
      fields: ['invitation inv_0', 'role: viewer'],
    }),
    auditRow(4, 180, 'invite:create', 'access', 'POST /api/sites/:siteId/invitations', {
      target: 'marketing@client.test',
      fields: ['invitation inv_0', 'role: viewer'],
    }),
    auditRow(3, 300, 'read:identity', 'identity', 'GET /api/sites/:siteId/realtime/stream', {
      actor: { kind: 'key', id: 'k_backend' },
      fields: ['ip', 'userId'],
    }),
    auditRow(2, 1500, 'read:identity', 'identity', 'GET /api/sites/:siteId/users/:userId', {
      target: 'u_42',
      fields: ['ips', 'traits', 'userId'],
    }),
  ],
  accounts: {
    u_demo: { email: DEMO_SITE.owner.email, name: DEMO_SITE.owner.name },
    u_ada: { email: 'ada@quillmoor.example', name: 'Ada Rahman' },
    u_client: { email: 'marketing@client.test', name: 'A client' },
  },
  next: null,
};

function metrics(visitors, over = {}) {
  return {
    visitors,
    pageviews: Math.round(visitors * 2.3),
    visits: Math.round(visitors * 1.1),
    bounces: Math.round(visitors * 0.34),
    bounceRate: 0.34,
    avgDurationMs: 154_000,
    ...over,
  };
}

// A week with a weekend in it. Hand written rather than generated, so a
// screenshot review can say whether the chart is drawing what it was given.
const DAILY = [2140, 2410, 2260, 2580, 2890, 1620, 1340];

export function timeseries(interval) {
  const step = interval === 'hour' ? 3_600_000 : interval === 'minute' ? 60_000 : 86_400_000;
  const count = interval === 'hour' ? 24 : interval === 'minute' ? 30 : DAILY.length;
  const start = NOW - count * step;
  const points = Array.from({ length: count }, (_point, index) => {
    const visitors =
      interval === 'day'
        ? (DAILY[index] ?? 0)
        : interval === 'hour'
          ? Math.round(40 + 90 * Math.sin((index / 24) * Math.PI))
          : Math.round(3 + 4 * Math.sin(index / 3));
    return {
      start: start + index * step,
      end: start + (index + 1) * step,
      metrics: metrics(Math.max(1, visitors)),
    };
  });
  return {
    interval,
    points,
    previous: points.map((point) => ({
      ...point,
      metrics: metrics(Math.max(1, Math.round(point.metrics.visitors * 0.82))),
    })),
  };
}

export const AGGREGATE = {
  metrics: metrics(15_240, { bounceRate: 0.34, avgDurationMs: 154_000 }),
  previous: metrics(12_980, { bounceRate: 0.38, avgDurationMs: 141_000 }),
};

const ROWS = {
  page: [
    '/',
    '/shop/beans',
    '/menu',
    '/subscriptions',
    '/brew-guides',
    '/events',
    '/journal/autumn-blend',
    '/about',
    '/visit-us',
    '/shop/grinders',
    '/account',
    '/contact',
  ],
  entry: ['/', '/shop/beans', '/subscriptions', '/menu', '/brew-guides'],
  exit: ['/subscriptions', '/', '/checkout', '/menu', '/visit-us'],
  channel: ['organic', 'direct', 'social', 'referral', 'ai', 'email'],
  referrer: [
    'google.com',
    'facebook.com',
    'news.ycombinator.com',
    'chatgpt.com',
    'linkedin.com',
    't.co',
  ],
  utm_source: ['newsletter', 'facebook', 'partner'],
  utm_medium: ['email', 'cpc', 'social'],
  utm_campaign: ['ramadan-2026', 'launch', 'alumni'],
  utm_term: ['competitive programming', 'c tutorial'],
  utm_content: ['hero', 'footer'],
  country: ['BD', 'IN', 'US', 'GB', 'PK', 'AE', 'MY', 'CA', 'SA', 'AU', 'DE', 'SG'],
  region: ['Dhaka', 'Chattogram', 'West Bengal', 'California', 'Sindh'],
  city: ['Dhaka', 'Chattogram', 'Kolkata', 'Sylhet', 'Karachi', 'Dubai'],
  browser: ['Chrome', 'Safari', 'Edge', 'Firefox', 'Samsung Internet'],
  os: ['Android', 'Windows', 'iOS', 'macOS', 'Linux'],
  // A browser with a system it actually ships on. The visitor list pairs them
  // by index, and a screenshot that puts Safari on Windows and Samsung
  // Internet on Linux is a picture a developer stops reading.
  agent: [
    { browser: 'Chrome', os: 'Android', device: 'mobile', screen: '360-767' },
    { browser: 'Chrome', os: 'Windows', device: 'desktop', screen: '1440+' },
    { browser: 'Safari', os: 'iOS', device: 'mobile', screen: '360-767' },
    { browser: 'Safari', os: 'macOS', device: 'desktop', screen: '1024-1439' },
    { browser: 'Edge', os: 'Windows', device: 'desktop', screen: '1024-1439' },
    { browser: 'Firefox', os: 'Linux', device: 'desktop', screen: '1440+' },
    { browser: 'Samsung Internet', os: 'Android', device: 'mobile', screen: '360-767' },
  ],
  device: ['mobile', 'desktop', 'tablet'],
  screen: ['360-767', '768-1023', '1024-1439', '1440+'],
  lang: ['bn', 'en', 'hi', 'ur'],
  event: ['signup', '404', 'brew_guide_open', 'checkout_start'],
};

// A different curve per dimension, because every card showing the same five
// figures is a fixture that looks like a fixture: a country list falls away
// steeply, a device list is three rows that nearly halve, a page list has a
// long tail. The shape is what a screenshot is read for.
const FALLOFF = {
  page: 1.45,
  entry: 1.3,
  exit: 1.25,
  channel: 1.9,
  referrer: 1.75,
  country: 2.1,
  region: 1.6,
  city: 1.55,
  browser: 2.3,
  os: 1.8,
  device: 2.6,
  screen: 1.4,
  lang: 2.2,
  event: 1.7,
};

const TOP = {
  page: 4_210,
  entry: 3_980,
  exit: 3_640,
  channel: 6_120,
  referrer: 2_870,
  country: 8_940,
  region: 3_110,
  city: 2_760,
  browser: 7_480,
  os: 6_920,
  device: 9_150,
  screen: 5_330,
  lang: 8_210,
  event: 1_480,
};

export function breakdown(dim, limit = 10) {
  const keys = ROWS[dim] ?? ['(none)'];
  const top = TOP[dim] ?? 3_000;
  const falloff = FALLOFF[dim] ?? 1.5;
  const rows = keys.slice(0, limit).map((key, index) => ({
    key,
    metrics: metrics(Math.max(11, Math.round(top / falloff ** index)), {
      // A rate that is the same on every row is a column nobody reads, and on
      // a screenshot it reads as a bug. These walk, so the Sources report shows
      // what it is for: search bounces less than social.
      bounceRate: Math.round((0.22 + ((index * 7) % 9) * 0.045) * 100) / 100,
      avgDurationMs: 60_000 + ((index * 5) % 7) * 31_000,
    }),
  }));
  return { dim, rows };
}

// Scroll depth is a percentage, not a fraction: the tracker reports a quartile
// as 0, 25, 50, 75 or 100 and the store averages those numbers.
export const ENGAGEMENT = {
  dim: 'page',
  rawOnly: true,
  rows: [
    { key: '/journal/autumn-blend', avgTimeOnPageMs: 214_000, avgScrollDepth: 86, leaves: 412 },
    { key: '/brew-guides', avgTimeOnPageMs: 186_000, avgScrollDepth: 71, leaves: 388 },
    { key: '/shop/beans', avgTimeOnPageMs: 96_000, avgScrollDepth: 54, leaves: 640 },
    { key: '/subscriptions', avgTimeOnPageMs: 41_000, avgScrollDepth: 49, leaves: 512 },
    { key: '/menu', avgTimeOnPageMs: 302_000, avgScrollDepth: 31, leaves: 260 },
    // Opened often, never closed yet: no number, and not a zero.
    { key: '/events', avgTimeOnPageMs: null, avgScrollDepth: null, leaves: 0 },
  ],
};

const PLACES = [
  { city: 'Dhaka', country: 'BD', lat: 23.81, lon: 90.41 },
  { city: 'Chattogram', country: 'BD', lat: 22.36, lon: 91.78 },
  { city: 'Kolkata', country: 'IN', lat: 22.57, lon: 88.36 },
  { city: 'Karachi', country: 'PK', lat: 24.86, lon: 67.01 },
  { city: 'Dubai', country: 'AE', lat: 25.2, lon: 55.27 },
  { city: 'London', country: 'GB', lat: 51.51, lon: -0.13 },
  { city: 'New York', country: 'US', lat: 40.71, lon: -74.01 },
  { city: 'Singapore', country: 'SG', lat: 1.35, lon: 103.82 },
];

function visitor(index, minutesAgo) {
  const place = PLACES[index % PLACES.length];
  return {
    // Distinct enough to read as different people at a glance, which is what a
    // list of visitor ids is for.
    visitorId: `v_${(index * 7919 + 104729).toString(36)}${(index * 31 + 7).toString(36)}`,
    sessionId: `s_${index}`,
    since: NOW - (minutesAgo + 4) * 60_000,
    lastSeenAt: NOW - minutesAgo * 60_000,
    path: ROWS.page[index % ROWS.page.length],
    country: place.country,
    city: place.city,
    lat: place.lat,
    lon: place.lon,
    // Only the three fields a presence entry carries: the screen bucket
    // belongs to a stored event, not to this.
    browser: ROWS.agent[index % ROWS.agent.length].browser,
    os: ROWS.agent[index % ROWS.agent.length].os,
    device: ROWS.agent[index % ROWS.agent.length].device,
  };
}

export const REALTIME = {
  online: 9,
  signedIn: 3,
  anonymous: 6,
  byPage: ROWS.page.slice(0, 5).map((key, index) => ({ key, visitors: 5 - index })),
  byCountry: ['BD', 'IN', 'PK', 'GB'].map((key, index) => ({ key, visitors: 5 - index })),
  byCity: PLACES.map((place, index) => ({
    key: place.city,
    country: place.country,
    lat: place.lat,
    lon: place.lon,
    visitors: Math.max(1, 5 - index),
  })),
  visitors: Array.from({ length: 9 }, (_row, index) => visitor(index, 0)),
  recent: Array.from({ length: 6 }, (_row, index) => visitor(index + 9, 3 + index * 4)),
};

export const PROFILE = {
  siteId: SITE.id,
  visitorId: 'v_abcdef0001',
  firstSeenAt: NOW - 46 * 86_400_000,
  lastSeenAt: NOW - 9 * 60_000,
  pageviews: 128,
  events: 14,
  sessions: 22,
  homeGeo: { country: 'BD', city: 'Dhaka', lat: 23.8103456, lon: 90.4125123 },
  devices: ['Chrome on Android', 'Chrome on Windows'],
  ips: [],
  firstTouch: { channel: 'organic', referrer: 'google.com' },
  lastTouch: { channel: 'direct' },
  // Four stays of three things, the way ingest stamps them: a profile reads as
  // the visits it was, and a fixture with one event per stay photographs a log.
  timeline: Array.from({ length: 12 }, (_entry, index) => ({
    ts: NOW - Math.floor(index / 3) * 9 * 3_600_000 - (index % 3) * 4 * 60_000,
    type: index % 5 === 3 ? 'event' : index % 7 === 6 ? 'leave' : 'pageview',
    sessionId: `s_${4 - Math.floor(index / 3)}`,
    ...(index % 5 === 3
      ? { name: ROWS.event[index % ROWS.event.length] }
      : { path: ROWS.page[index % ROWS.page.length] }),
  })),
};

// Two goals, one of each kind, and what they counted. The same shapes the goal
// routes answer: the goal record from the control plane, a conversion from the
// store, visitors a day at a time and the rate a share of them.
export const GOALS = [
  {
    siteId: 's_demo',
    id: 'g_signup',
    kind: 'event',
    match: 'signup',
    name: 'Signed up',
    value: 1,
    createdBy: 'u_demo',
    createdAt: NOW - 20 * 86_400_000,
  },
  {
    siteId: 's_demo',
    id: 'g_checkout',
    kind: 'page',
    match: '/*/checkout/done',
    name: 'Checked out',
    createdBy: 'u_demo',
    createdAt: NOW - 6 * 86_400_000,
  },
];

function conversionOf(visitors, rate, value) {
  const converted = Math.round(visitors * rate);
  const completions = Math.round(converted * 1.18);
  return {
    visitors: converted,
    completions,
    rate: visitors === 0 ? null : converted / visitors,
    value: value === undefined ? null : completions * value,
  };
}

// A goal read against the aggregate: the site's own figure.
export function aggregateFor(goalId) {
  const goal = GOALS.find((candidate) => candidate.id === goalId);
  if (goal === undefined) {
    return AGGREGATE;
  }
  return {
    ...AGGREGATE,
    conversion: conversionOf(AGGREGATE.metrics.visitors, 0.061, goal.value),
    previousConversion: conversionOf(AGGREGATE.previous.visitors, 0.054, goal.value),
  };
}

// Every row of a breakdown with a conversion on it. The rate walks by row, the
// way the bounce rate does, because a column where every row reads the same is
// a column that reads as a bug: search converts better than social here.
export function breakdownFor(dim, limit, goalId) {
  const answer = breakdown(dim, limit);
  const goal = GOALS.find((candidate) => candidate.id === goalId);
  if (goal === undefined) {
    return answer;
  }
  return {
    ...answer,
    rows: answer.rows.map((row, index) => ({
      ...row,
      conversion: conversionOf(
        row.metrics.visitors,
        Math.round((0.038 + ((index * 5) % 7) * 0.011) * 1000) / 1000,
        goal.value,
      ),
    })),
  };
}

export function goalStats() {
  const visitors = AGGREGATE.metrics.visitors;
  return {
    visitors,
    rows: [
      { goal: GOALS[0], conversion: conversionOf(visitors, 0.061, GOALS[0].value) },
      { goal: GOALS[1], conversion: conversionOf(visitors, 0.017, GOALS[1].value) },
    ],
    rawOnly: true,
  };
}

// Two funnels, the shape the funnel routes answer: steps copied from goals or
// typed as paths, and a window each.
export const FUNNELS = [
  {
    siteId: 's_demo',
    id: 'f_course',
    name: 'Shop page to order',
    window: '7d',
    steps: [
      { kind: 'page', match: '/shop/*', name: 'A shop page' },
      { kind: 'page', match: '/subscriptions', name: '/subscriptions' },
      { kind: 'event', match: 'checkout_start', name: 'Started checkout' },
      { kind: 'page', match: '/*/checkout/done', name: 'Checked out', goalId: 'g_checkout' },
    ],
    createdBy: 'u_demo',
    createdAt: NOW - 5 * 86_400_000,
  },
  {
    siteId: 's_demo',
    id: 'f_signup',
    name: 'Signed up in one sitting',
    window: 'visit',
    steps: [
      { kind: 'page', match: '/', name: '/' },
      { kind: 'event', match: 'signup', name: 'Signed up', goalId: 'g_signup' },
    ],
    createdBy: 'u_demo',
    createdAt: NOW - 2 * 86_400_000,
  },
];

// What a funnel counted, built the way the store builds it: a count of people
// per step, the drop between two and the shares as fractions.
export function funnelStats(funnelId) {
  const funnel = FUNNELS.find((candidate) => candidate.id === funnelId) ?? FUNNELS[0];
  const reached = funnel.id === 'f_signup' ? [4_980, 612] : [4_210, 1_380, 412, 259];
  return {
    funnel,
    visitors: AGGREGATE.metrics.visitors,
    steps: reached.map((visitors, index) => {
      const previous = index === 0 ? null : reached[index - 1];
      return {
        visitors,
        dropOff: previous === null ? 0 : previous - visitors,
        rate: visitors / reached[0],
        stepRate: previous === null ? null : visitors / previous,
      };
    }),
    rawOnly: true,
  };
}

// The paths of the week, by how many visits took each, folded by the store's
// own functions so the flow is the shape the journeys route answers.
const WALKS = [
  [['/', '/shop/beans', '/subscriptions', '/checkout'], 610],
  [['/', '/shop/beans', '/brew-guides'], 540],
  [['/', '/subscriptions', '/checkout', '/checkout/done'], 380],
  [['/', '/menu'], 720],
  [['/', '/events', '/events/cupping-night'], 260],
  [['/shop/beans', '/subscriptions', '/checkout', '/checkout/done', '/brew-guides'], 410],
  [['/shop/beans', '/brew-guides', '/menu'], 330],
  [['/brew-guides', '/menu', '/brew-guides', '/menu'], 520],
  [['/brew-guides'], 440],
  [['/subscriptions', '/checkout'], 290],
  [['/journal/autumn-blend', '/', '/shop/beans'], 180],
  [['/menu', '/brew-guides'], 210],
  [['/about'], 120],
];

export function journeys(branches) {
  const paths = WALKS.flatMap(([walk, count]) =>
    Array.from({ length: count }, () => journeyPath(walk)),
  );
  return finishJourneys(journeyStepCounts(paths, topJourneyPages(paths, branches)), branches);
}

// The custom events of the range. A page timing is not among them.
export const EVENTS = {
  visitors: AGGREGATE.metrics.visitors,
  rows: [
    { key: 'signup', visitors: 930, events: 1_104 },
    { key: 'brew_guide_open', visitors: 612, events: 4_870 },
    { key: 'checkout_start', visitors: 348, events: 391 },
    { key: '404', visitors: 121, events: 143 },
    { key: 'quiz_start', visitors: 96, events: 188 },
  ].map((row) => ({ ...row, rate: row.visitors / AGGREGATE.metrics.visitors })),
  rawOnly: true,
};

// One event by one property. The names a page passed, most used first, and
// the rows of the one asked for; an event without the property is the unknown
// row, so the rows add up to the event.
const PROPERTY_ROWS = {
  plan: [
    ['free', 612, 701],
    ['pro', 244, 296],
    ['team', 51, 77],
    ['', 23, 30],
  ],
  source: [
    ['hero', 402, 470],
    ['pricing', 318, 371],
    ['footer', 144, 181],
    ['', 66, 82],
  ],
  referral_code: [
    ['IMUPC2026', 88, 90],
    ['', 842, 1_014],
  ],
};

export function properties(event, property) {
  const names = Object.keys(PROPERTY_ROWS);
  const chosen = property !== null && names.includes(property) ? property : names[0];
  return {
    event,
    properties: [
      { key: 'plan', events: 1_104 },
      { key: 'source', events: 1_104 },
      { key: 'referral_code', events: 90 },
    ],
    property: chosen,
    visitors: AGGREGATE.metrics.visitors,
    rows: PROPERTY_ROWS[chosen].map(([key, visitors, events]) => ({
      key,
      visitors,
      events,
      rate: visitors / AGGREGATE.metrics.visitors,
    })),
    rawOnly: true,
  };
}

// ------------------------------------------------- retention (AN-PPL01)
//
// Each retention and health read takes its own window, which the page works
// out from its own clock: the frozen one in the screenshots, the reader's in
// the demo. So these answer the window they are asked, and every number goes
// through the store's own functions (the plan, then the finish or the fold),
// so the shape is the one the routes answer and the buckets are the site's
// calendar. A window ends at the end of the site's today, and these reads take
// the last instant before it as now: today is still running, and so is the
// week or the month it is in, as on a real install.

const TZ = SITE.settings.timezone;
const HOUR = 3_600_000;

// A small fixed wobble, so no two cells of a grid read the same and no run of
// the fixture differs from the last.
function wobble(seed, size) {
  return ((((seed * 2_654_435_761) >>> 0) % 1_000) / 1_000 - 0.5) * 2 * size;
}

// A whole split into whole parts by weight, the parts adding up to exactly
// the whole (largest remainder), so a column of a report adds up.
function share(total, weights) {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  const exact = weights.map((weight) => (total * weight) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((acc, part) => acc + part, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index] += 1;
    left -= 1;
  }
  return parts;
}

// The start of the site's today in a window that ends with it: a time a row
// was last seen is put before it, so it is never in the reader's future.
function startOfLastDay(to) {
  const plan = activityPlan({ siteId: SITE.id, from: to - 1, to }, TZ);
  return plan.starts[plan.starts.length - 1];
}

// Of the people first seen in a week (or a month), the share back in each
// later one: a steep first drop, then a floor of regulars, which is what a
// shop with a subscription looks like. About two in three of a week's 15.2K
// visitors are new, so a weekly cohort is near 9.8K.
const COHORT_SHAPE = {
  week: { size: 9_800, first: 0.155, keep: 0.68, floor: 0.034 },
  month: { size: 38_500, first: 0.21, keep: 0.62, floor: 0.052 },
};

export function cohorts(from, to, interval) {
  const plan = cohortPlan({ siteId: SITE.id, from, to, interval }, TZ);
  const now = to - 1;
  const shape = COHORT_SHAPE[interval];
  const last = plan.starts.length - 1;
  // The bucket still running has seen only part of its people.
  const elapsed = (bucket) =>
    Math.min(1, (now - plan.starts[bucket]) / (plan.ends[bucket] - plan.starts[bucket]));
  const counts = new Map();
  plan.starts.forEach((_start, cohort) => {
    const grown = 0.88 + (0.12 * cohort) / Math.max(1, last);
    const size = Math.round(shape.size * grown * (1 + wobble(cohort + 1, 0.05)) * elapsed(cohort));
    addCohortCell(counts, cohort, cohort, size);
    for (let bucket = cohort + 1; bucket <= last; bucket += 1) {
      const k = bucket - cohort;
      const rate = shape.floor + (shape.first - shape.floor) * shape.keep ** (k - 1);
      const back = Math.round(size * rate * (1 + wobble(cohort * 31 + k, 0.09)) * elapsed(bucket));
      addCohortCell(counts, cohort, bucket, back);
    }
  });
  return finishCohorts(plan, counts, now);
}

// The overview's week, Monday first, as the shape of every week.
const WEEKDAY = [2_140, 2_410, 2_260, 2_580, 2_890, 1_620, 1_340];

// How many days of the range people came on: most once, a few on many. The
// weights are the curve's shape; the visitors are worked out from them, so the
// person-days the curve holds are the days' own visitors added up. The second
// term is the regulars, thinning out towards every day of the window.
function curveWeights(days) {
  return Array.from({ length: days }, (_value, index) => 0.47 ** index + 0.0016 * 0.94 ** index);
}

export function activity(from, to) {
  const plan = activityPlan({ siteId: SITE.id, from, to }, TZ);
  const now = to - 1;
  // Every day the plan reads, the month before the range included.
  const all = plan.starts.map((start, index) => {
    // Monday is 0, read at the site's noon.
    const weekday = (new Date(start + 12 * HOUR).getUTCDay() + 6) % 7;
    const trend = 0.92 + (0.08 * index) / plan.starts.length;
    const running = plan.ends[index] > now ? 0.6 : 1;
    return Math.round(WEEKDAY[weekday] * 1.04 * trend * (1 + wobble(index + 7, 0.06)) * running);
  });
  const sum = (end, width) =>
    all.slice(Math.max(0, end - width + 1), end + 1).reduce((acc, value) => acc + value, 0);
  const tally = { dau: [], wau: [], mau: [], curve: [], visitors: 0, returning: 0 };
  for (let day = 0; day < plan.days; day += 1) {
    const at = plan.offset + day;
    tally.dau.push(all[at]);
    // Some of a week's people come on more than one day of it, so a week
    // is the overview's 15.2K; more of a month's do.
    tally.wau.push(Math.round(sum(at, 7) * 0.96));
    tally.mau.push(Math.round(sum(at, 30) * 0.74));
  }
  const personDays = tally.dau.reduce((acc, value) => acc + value, 0);
  const weights = curveWeights(plan.days);
  const meanDays =
    weights.reduce((acc, weight, index) => acc + weight * (index + 1), 0) /
    weights.reduce((acc, weight) => acc + weight, 0);
  tally.visitors = Math.round(personDays / meanDays);
  tally.curve = share(tally.visitors, weights);
  // Everybody on more than one day came back, and so did a fifth of the
  // one-day people, first seen before the range began.
  tally.returning = tally.visitors - tally.curve[0] + Math.round(tally.curve[0] * 0.2);
  return finishActivity(plan, tally, now);
}

// ------------------------------------------------- people (AN-PPL02)

// Invented people, plainly: first and last names put together for this file,
// at addresses under .example, which can never be anybody's.
const NAMED = [
  ['Tamsin Holloway', 'pro'],
  ['Idris Fenwick', 'free'],
  ['Noor Abernethy', 'pro'],
  ['Oskar Ludlow', 'free'],
  ['Priya Marchetti', 'team'],
  ['Wren Ashdown', 'pro'],
  ['Kofi Brightwell', 'free'],
  ['Lena Quayle', 'pro'],
  ['Matteo Corrigan', 'free'],
  ['Sabine Okonjo', 'team'],
  ['Hugo Pemberly', 'free'],
  ['Yara Castellan', 'pro'],
  ['Felix Ravenscroft', 'free'],
  ['Amara Lindqvist', 'pro'],
  ['Desmond Achterberg', 'free'],
  ['Ines Vanterpool', 'team'],
  ['Rohan Kestrel', 'free'],
  ['Mei Thornbury', 'pro'],
  ['Bastian Okoro', 'free'],
  ['Clio Wetherell', 'pro'],
  ['Teodor Marchbank', 'free'],
  ['Zainab Ellery', 'pro'],
];

const DEVICE_NAMES = ROWS.agent.map((agent) => `${agent.browser} on ${agent.os}`);
// The profile the README shows, as its row: anonymous, as its own page draws it.
const PROFILE_ROW = 3;

// Twenty-eight people, most recent first. The first three are online now
// (the ids Realtime lists), so the directory marks them.
export const PEOPLE = Array.from({ length: 28 }, (_row, index) => {
  if (index === PROFILE_ROW) {
    return {
      visitorId: PROFILE.visitorId,
      firstSeenAt: PROFILE.firstSeenAt,
      lastSeenAt: PROFILE.lastSeenAt,
      sessions: PROFILE.sessions,
      pageviews: PROFILE.pageviews,
      homeGeo: PROFILE.homeGeo,
      devices: PROFILE.devices,
      ips: [],
    };
  }
  const place = PLACES[(index * 3) % PLACES.length];
  const sessions = Math.max(1, Math.round(38 / (1 + index * 0.35)));
  const row = {
    visitorId:
      index < 3 ? visitor(index, 0).visitorId : `v_${(index * 104_729 + 7_919).toString(36)}q`,
    firstSeenAt: NOW - (12 + ((index * 17) % 160)) * 86_400_000,
    lastSeenAt: NOW - (index < 3 ? index * 60_000 : (index * index * 0.6 + index) * HOUR),
    sessions,
    pageviews: Math.round(sessions * (2.1 + (index % 4) * 0.4)),
    homeGeo: { country: place.country, city: place.city, lat: place.lat, lon: place.lon },
    devices: [DEVICE_NAMES[index % DEVICE_NAMES.length]],
    ips: [],
  };
  if (index % 7 === 5) {
    return row;
  }
  // One name per person, in order: the named rows before this one each took
  // one, and a row past the names stays anonymous.
  const before = Array.from({ length: index }, (_each, at) => at).filter(
    (at) => at !== PROFILE_ROW && at % 7 !== 5,
  ).length;
  const named = NAMED[before];
  if (named === undefined) {
    return row;
  }
  const [name, plan] = named;
  const email = `${name.toLowerCase().replace(' ', '.')}@quillmoor.example`;
  return { ...row, userId: `cus_${4_100 + index * 37}`, traits: { name, email, plan } };
});

// One page of the directory. The search matches a piece of the visitor id,
// the userId or any trait value, as the store's does; the cursor is where the
// page before stopped.
export function peoplePage({ limit, cursor, identifiedOnly, q }) {
  const wanted = (q ?? '').toLowerCase();
  const rows = PEOPLE.filter((row) => !identifiedOnly || row.userId !== undefined).filter(
    (row) =>
      wanted === '' ||
      [row.visitorId, row.userId ?? '', ...Object.values(row.traits ?? {})].some((value) =>
        value.toLowerCase().includes(wanted),
      ),
  );
  const start = cursor !== null && cursor.startsWith('c_') ? Number(cursor.slice(2)) || 0 : 0;
  const people = rows.slice(start, start + limit);
  return { people, next: start + limit < rows.length ? `c_${start + limit}` : null };
}

// The most active people of a window: the regulars of the directory, on more
// days the longer the window, each last seen before the window's last day.
export function powerUsers(from, to, limit) {
  const plan = activityPlan({ siteId: SITE.id, from, to }, TZ);
  const minDays = powerMinDays(plan.days);
  const today = startOfLastDay(to);
  const regulars = PEOPLE.filter((row) => row.sessions > 6).slice(0, limit);
  const top = Math.round(plan.days * 0.82);
  const people = regulars.map((row, index) => {
    const activeDays = Math.max(minDays, top - Math.round((index * (top - minDays)) / regulars.length));
    // The directory's own time where the window holds it, as in the
    // pictures; otherwise the evening before the window's last day.
    const inside = row.lastSeenAt >= from && row.lastSeenAt < to;
    return {
      ...row,
      lastSeenAt: inside ? row.lastSeenAt : today - (index * 2 + 1) * HOUR,
      activeDays,
      visits: activeDays + Math.round(activeDays * (0.6 - index * 0.02)),
    };
  });
  return { people, days: plan.days, minDays, rawOnly: true };
}

// ------------------------------------------------- attribution

// What first brought the people who converted, and what brought the visit
// they converted in, as weights of the first touch and of the last. Direct
// gains in the last touch: people come back by typing the address, or from a
// mail.
const TOUCHES = {
  channel: [
    ['organic', 34, 26],
    ['direct', 22, 38],
    ['social', 16, 10],
    ['referral', 12, 8],
    ['ai', 9, 5],
    ['email', 7, 13],
  ],
  referrer: [
    ['', 30, 47],
    ['google.com', 26, 21],
    ['facebook.com', 14, 9],
    ['chatgpt.com', 10, 6],
    ['news.ycombinator.com', 8, 4],
    ['linkedin.com', 7, 8],
    ['t.co', 5, 5],
  ],
  utm_source: [
    ['', 78, 70],
    ['newsletter', 10, 17],
    ['facebook', 8, 9],
    ['partner', 4, 4],
  ],
  utm_medium: [
    ['', 78, 70],
    ['email', 10, 17],
    ['social', 8, 9],
    ['cpc', 4, 4],
  ],
  utm_campaign: [
    ['', 80, 72],
    ['launch', 9, 12],
    ['ramadan-2026', 7, 11],
    ['alumni', 4, 5],
  ],
  entry: [
    ['/', 31, 36],
    ['/shop/beans', 24, 18],
    ['/subscriptions', 15, 24],
    ['/menu', 12, 9],
    ['/brew-guides', 11, 8],
    ['/journal/autumn-blend', 7, 5],
  ],
};

// Converters a week, as the events report and the goals report count them:
// 930 signed up, 259 checked out.
const CONVERTERS_A_WEEK = { g_signup: 930, g_checkout: 259 };

export function attribution(from, to, goal, dim) {
  const days = Math.max(1, Math.round((to - from) / 86_400_000));
  // Each converter once over the whole range, so a longer one is a little
  // less than its weeks added up.
  const visitors = Math.round(((CONVERTERS_A_WEEK[goal.id] ?? 120) * days * 0.92) / 7);
  const completions = Math.round(visitors * 1.18);
  const rows = TOUCHES[dim];
  const [first, last] = [1, 2].map((column) => {
    const weights = rows.map((row) => row[column]);
    const people = share(visitors, weights);
    const times = share(completions, weights);
    return new Map(rows.map((row, index) => [row[0], { visitors: people[index], completions: times[index] }]));
  });
  return finishAttribution(dim, goal, first, last);
}

// ------------------------------------------------- health (AN-VIT01)

// The pages with a speed worth reading, how busy each is next to the home
// page, and their medians on a desktop. The shop's photos make its page slow,
// the journal shifts as its images arrive, and the events page is a heavy
// embed.
const VITAL_PAGES = [
  ['/', 1, { LCP: 1_650, INP: 110, CLS: 0.03, FCP: 980, TTFB: 260 }],
  ['/shop/beans', 0.69, { LCP: 2_700, INP: 230, CLS: 0.05, FCP: 1_350, TTFB: 340 }],
  ['/menu', 0.48, { LCP: 1_900, INP: 95, CLS: 0.08, FCP: 1_100, TTFB: 280 }],
  ['/subscriptions', 0.33, { LCP: 1_500, INP: 140, CLS: 0.02, FCP: 900, TTFB: 300 }],
  ['/brew-guides', 0.23, { LCP: 2_150, INP: 90, CLS: 0.04, FCP: 1_200, TTFB: 250 }],
  ['/events', 0.16, { LCP: 3_600, INP: 310, CLS: 0.06, FCP: 1_900, TTFB: 520 }],
  ['/journal/autumn-blend', 0.11, { LCP: 2_400, INP: 85, CLS: 0.19, FCP: 1_250, TTFB: 240 }],
  ['/about', 0.05, { LCP: 1_300, INP: 70, CLS: 0.01, FCP: 820, TTFB: 230 }],
];

// The share of the samples each kind of device sends, how much slower it is,
// and how much more its layout shifts (a narrow screen reflows more).
const VITAL_DEVICES = [
  ['desktop', 0.38, 1, 0.8],
  ['mobile', 0.55, 1.45, 1.25],
  ['tablet', 0.07, 1.2, 1],
];

// The share of pageviews that report each metric: not every visit interacts,
// so INP has the fewest.
const VITAL_REACH = { LCP: 0.9, INP: 0.55, CLS: 0.92, FCP: 0.95, TTFB: 0.96 };

// A spread around the median, as multiples of it and their weights, so the
// p75 sits about a third above the median.
const SPREAD = [
  [0.45, 4],
  [0.6, 8],
  [0.75, 12],
  [0.88, 14],
  [1, 14],
  [1.15, 12],
  [1.35, 10],
  [1.6, 8],
  [2, 5],
  [2.7, 3],
];

// The home page's samples a week, on every device together.
const VITAL_SAMPLES_A_WEEK = 3_900;

export function vitals(from, to, device, sort) {
  const days = Math.max(1, Math.round((to - from) / 86_400_000));
  const cells = [];
  VITAL_PAGES.forEach(([page, weight, medians], pageIndex) => {
    for (const [name, deviceShare, slower, shifts] of VITAL_DEVICES) {
      if (device !== null && device !== name) continue;
      for (const metric of VITAL_METRICS) {
        const samples = Math.round(
          ((VITAL_SAMPLES_A_WEEK * days) / 7) * weight * deviceShare * VITAL_REACH[metric],
        );
        if (samples === 0) continue;
        const counts = share(
          samples,
          SPREAD.map(([, n]) => n),
        );
        const histogram = new Map();
        SPREAD.forEach(([factor], index) => {
          const value =
            medians[metric] *
            (metric === 'CLS' ? shifts : slower) *
            factor *
            (1 + wobble(pageIndex * 13 + index, 0.04));
          const q = vitalBucket(metric, value);
          if (q !== null && counts[index] > 0) histogram.set(q, (histogram.get(q) ?? 0) + counts[index]);
        });
        cells.push({ page, device: name, metric, buckets: [...histogram].map(([q, n]) => ({ q, n })) });
      }
    }
  });
  return foldVitals(cells, sort);
}

// Four weeks of errors as the collector keeps them: a scrubbed message, the
// newest row as its sample, and the pages and browsers it happened on. Each
// has been happening since `since` days before the window's last day and was
// last seen `lastHour` hours before that day began; a shorter window holds
// the share of it that falls inside.
const ERRORS = [
  {
    message: "TypeError: Cannot read properties of undefined (reading 'roast')",
    count: 412,
    visitors: 233,
    pages: [['/shop/beans', 301], ['/subscriptions', 88], ['/shop/grinders', 23]],
    browsers: [['Chrome', 260], ['Samsung Internet', 98], ['Edge', 54]],
    sample: {
      page: '/shop/beans',
      browser: 'Chrome',
      frame: 'https://quillmoor.example/assets/shop-3f9a1c.js:1:48211',
      stack:
        "TypeError: Cannot read properties of undefined (reading 'roast')\n    at roastLabel (https://quillmoor.example/assets/shop-3f9a1c.js:1:48211)\n    at Array.map (<anonymous>)\n    at renderBeans (https://quillmoor.example/assets/shop-3f9a1c.js:1:47902)",
    },
    since: 26,
    lastHour: 2,
  },
  {
    message: 'ResizeObserver loop completed with undelivered notifications.',
    count: 288,
    visitors: 190,
    pages: [['/menu', 141], ['/brew-guides', 97], ['/', 50]],
    browsers: [['Chrome', 172], ['Edge', 70], ['Firefox', 46]],
    sample: { page: '/menu', browser: 'Chrome' },
    since: 28,
    lastHour: 5,
  },
  {
    message: 'Unhandled rejection: TypeError: Failed to fetch',
    count: 131,
    visitors: 97,
    pages: [['/checkout', 84], ['/subscriptions', 47]],
    browsers: [['Safari', 79], ['Chrome', 52]],
    sample: {
      page: '/checkout',
      browser: 'Safari',
      frame: 'https://quillmoor.example/assets/checkout-81be02.js:1:9930',
      stack:
        'TypeError: Failed to fetch\n    at placeOrder (https://quillmoor.example/assets/checkout-81be02.js:1:9930)',
    },
    since: 9,
    lastHour: 11,
  },
  {
    message: 'ReferenceError: grindSizes is not defined',
    count: 64,
    visitors: 41,
    pages: [['/brew-guides', 64]],
    browsers: [['Firefox', 37], ['Safari', 27]],
    sample: {
      page: '/brew-guides',
      browser: 'Firefox',
      frame: 'https://quillmoor.example/assets/guides-c47d10.js:1:2210',
      stack:
        'ReferenceError: grindSizes is not defined\n    at pickGrind (https://quillmoor.example/assets/guides-c47d10.js:1:2210)',
    },
    since: 4,
    lastHour: 20,
  },
  {
    message: "SyntaxError: Unexpected token '<'",
    count: 22,
    visitors: 19,
    pages: [['/events', 22]],
    browsers: [['Safari', 22]],
    sample: { page: '/events', browser: 'Safari' },
    since: 15,
    lastHour: 30,
  },
  {
    message: 'Script error.',
    count: 17,
    visitors: 15,
    pages: [['/', 11], ['/menu', 6]],
    browsers: [['Safari', 17]],
    sample: { page: '/', browser: 'Safari' },
    since: 21,
    lastHour: 44,
  },
];

export function errors(from, to, limit) {
  const days = Math.max(1, Math.round((to - from) / 86_400_000));
  const today = startOfLastDay(to);
  const kept = ERRORS.map((error) => ({
    error,
    // The part of its four weeks that falls inside the window.
    scale: Math.min(days, error.since) / Math.min(28, error.since),
  }));
  const scaled = (n, scale) => Math.max(1, Math.round(n * scale));
  const messages = kept.map(({ error, scale }) => {
    const lastSeen = today - error.lastHour * HOUR;
    return {
      message: error.message,
      count: scaled(error.count, scale),
      visitors: scaled(error.visitors, scale),
      firstSeen: Math.max(from, today - error.since * 86_400_000),
      lastSeen,
      sample: { at: lastSeen, ...error.sample },
    };
  });
  const facet = (key) =>
    kept.flatMap(({ error, scale }) =>
      error[key].map(([value, n]) => ({
        message: error.message,
        key: value,
        count: Math.max(1, Math.floor(n * scale)),
      })),
    );
  return foldErrors(
    {
      total: messages.reduce((acc, row) => acc + row.count, 0),
      // Some people met more than one of them.
      visitors: Math.round(messages.reduce((acc, row) => acc + row.visitors, 0) * 0.86),
      groupsTotal: messages.length,
      messages,
      pages: facet('pages'),
      browsers: facet('browsers'),
    },
    limit,
  );
}

// Of the customers the shop's own server named, the share no browser row
// carries: about one in six, blocked or declined. Distinct people grow more
// slowly than the window does.
export function coverage(from, to) {
  const days = Math.max(1, Math.round((to - from) / 86_400_000));
  const people = Math.round(640 * (days / 28) ** 0.6);
  const seen = Math.round(people * 0.83);
  const browserOnly = Math.round(people * 0.12);
  return foldCoverage([
    ...Array.from({ length: people }, (_row, index) => ({
      userId: `cus_s${index}`,
      server: true,
      browser: index < seen,
    })),
    ...Array.from({ length: browserOnly }, (_row, index) => ({
      userId: `cus_b${index}`,
      server: false,
      browser: true,
    })),
  ]);
}
