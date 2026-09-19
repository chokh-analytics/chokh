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

// A Friday, so the week in the charts has a shape rather than a plateau.
export const NOW = Date.UTC(2026, 8, 18, 9, 30, 0);

export const SITE = {
  id: 's_demo',
  name: 'Progsity',
  domains: ['progsity.io'],
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
  },
};

export const ME = {
  actor: { kind: 'session', id: 'u_demo' },
  user: { id: 'u_demo', email: 'owner@chokh.test', name: 'Abu Jafar' },
  sites: [
    SITE,
    { ...SITE, id: 's_docs', name: 'Chokh docs', domains: ['docs.chokh.test'] },
  ],
  teams: [{ id: 'default', name: 'Progsity', role: 'owner' }],
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
    '/courses/competitive-programming',
    '/playground',
    '/pricing',
    '/learn/c',
    '/contests',
    '/blog/why-we-built-chokh',
    '/about',
    '/docs/install',
    '/courses/dsa',
    '/login',
    '/contact',
  ],
  entry: ['/', '/courses/competitive-programming', '/pricing', '/playground', '/learn/c'],
  exit: ['/pricing', '/', '/checkout', '/playground', '/docs/install'],
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
  event: ['signup', '404', 'playground_run', 'checkout_start'],
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
    { key: '/blog/why-we-built-chokh', avgTimeOnPageMs: 214_000, avgScrollDepth: 86, leaves: 412 },
    { key: '/learn/c', avgTimeOnPageMs: 186_000, avgScrollDepth: 71, leaves: 388 },
    { key: '/courses/competitive-programming', avgTimeOnPageMs: 96_000, avgScrollDepth: 54, leaves: 640 },
    { key: '/pricing', avgTimeOnPageMs: 41_000, avgScrollDepth: 49, leaves: 512 },
    { key: '/playground', avgTimeOnPageMs: 302_000, avgScrollDepth: 31, leaves: 260 },
    // Opened often, never closed yet: no number, and not a zero.
    { key: '/contests', avgTimeOnPageMs: null, avgScrollDepth: null, leaves: 0 },
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
