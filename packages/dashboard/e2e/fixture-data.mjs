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

import { finishJourneys, journeyPath, journeyStepCounts, topJourneyPages } from '@chokh/store';

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
