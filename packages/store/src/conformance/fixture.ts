import { defaultSiteSettings, type Site, type StoredEvent } from '../types.js';

// One seeded world, shared by every adapter, so "the MongoDB answer" and "the
// in-memory answer" are the same sentence.
//
// The site sits in Asia/Dhaka, six hours ahead of UTC, because a day boundary
// that is only ever tested at UTC midnight is not tested at all. The clock is
// frozen at 2026-09-18 10:00 in Dhaka, which is 04:00 UTC, so:
//
//   Dhaka 2026-09-16  =  2026-09-15T18:00Z .. 2026-09-16T18:00Z   rolled up
//   Dhaka 2026-09-17  =  2026-09-16T18:00Z .. 2026-09-17T18:00Z   rolled up
//   Dhaka 2026-09-18  =  2026-09-17T18:00Z .. now                 raw, "today"
//
// The event at 2026-09-17T18:30Z is the one that proves it: UTC calls it the
// 17th, Dhaka calls it 00:30 on the 18th, and Dhaka is who the site is.
//
// The stays the 30 minute gap rule cuts out of this are listed beside EXPECTED
// below, because a session count that is only ever derived is not a fixture.

export const SITE_ID = 'site_fixture';
export const OTHER_SITE_ID = 'site_unknown';
export const TIMEZONE = 'Asia/Dhaka';

export const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
export const TODAY = '2026-09-18';
export const YESTERDAY = '2026-09-17';
export const DAY_BEFORE = '2026-09-16';

export const TODAY_START = Date.UTC(2026, 8, 17, 18, 0, 0);
export const YESTERDAY_START = Date.UTC(2026, 8, 16, 18, 0, 0);
export const DAY_BEFORE_START = Date.UTC(2026, 8, 15, 18, 0, 0);

// The instant that is the 17th in UTC and the 18th in Dhaka.
export const BOUNDARY_TS = Date.UTC(2026, 8, 17, 18, 30, 0);

export const RETENTION_DAYS = 30;

// The person v1 turns out to be, once the identify lands.
export const USER_ID = 'u_rafi';

// The one page in this world that answered something, and what it answered.
// Two of its views carry the status, one on a day that is rolled up and one on
// the raw day, so both halves of a read are proved; every other pageview here
// declares nothing, which is what an unlabelled pageview looks like and is not
// a 200.
export const NOT_FOUND_STATUS = '404';

// The one custom event in this world. v1 sends it once today with no page and
// no properties; v3 sends it on the 17th and again today, from /docs, with a
// plan. So a goal on it has converters on a rolled day and on the raw one.
export const SIGNUP = 'signup';
export const NOT_FOUND_PATH = '/docs';

export function fixtureSite(): Site {
  return {
    id: SITE_ID,
    name: 'Fixture',
    domains: ['fixture.test', 'www.fixture.test'],
    settings: defaultSiteSettings({
      ipMode: 'full',
      visitorIdMode: 'persistent',
      timezone: TIMEZONE,
      retentionDays: RETENTION_DAYS,
    }),
  };
}

const DHAKA = { country: 'BD', region: 'Dhaka', city: 'Dhaka', lat: 23.81, lon: 90.41, tz: TIMEZONE };
const CHATTOGRAM = { country: 'BD', region: 'Chattogram', city: 'Chattogram', tz: TIMEZONE };
// Kolkata carries more precision than the presence set is allowed to keep, so
// the rounding rule is proved end to end and not only in a unit test: v2 is the
// one visitor who is online, and this is the pair that reaches the map.
const KOLKATA = {
  country: 'IN',
  region: 'West Bengal',
  city: 'Kolkata',
  lat: 22.5726459,
  lon: 88.3638953,
  tz: 'Asia/Kolkata',
};

const ANDROID = { browser: 'Chrome', browserVersion: '130', os: 'Android', device: 'mobile' } as const;
const WINDOWS = { browser: 'Edge', browserVersion: '129', os: 'Windows', device: 'desktop' } as const;
const IPHONE = { browser: 'Safari', browserVersion: '18', os: 'iOS', device: 'mobile' } as const;

interface Draft {
  ts: number;
  type: StoredEvent['type'];
  visitor: 'v1' | 'v2' | 'v3' | 'bot';
  path?: string;
  name?: string;
  referrer?: string;
  utm?: Record<string, string>;
  // Only from the identify onwards, because that is all the collector ever
  // sends: everything before it is anonymous until the merge names it.
  userId?: string;
  duration?: number;
  scrollDepth?: number;
  status?: string;
  value?: number;
  props?: Record<string, string>;
}

const PROFILES = {
  v1: { geo: DHAKA, ua: ANDROID, ip: '103.87.12.9', lang: 'bn', screen: '412x915' },
  v2: { geo: KOLKATA, ua: WINDOWS, ip: '49.37.200.4', lang: 'en', screen: '1920x1080' },
  v3: { geo: CHATTOGRAM, ua: IPHONE, ip: '103.87.44.71', lang: 'bn', screen: '390x844' },
  bot: { geo: KOLKATA, ua: WINDOWS, ip: '66.249.66.1', lang: 'en', screen: '1024x768' },
} as const;

const DRAFTS: Draft[] = [
  // Dhaka 2026-09-16: v1 twice, v2 once.
  { ts: Date.UTC(2026, 8, 16, 3, 0, 0), type: 'pageview', visitor: 'v1', path: '/home' },
  { ts: Date.UTC(2026, 8, 16, 3, 5, 0), type: 'pageview', visitor: 'v1', path: '/pricing' },
  {
    ts: Date.UTC(2026, 8, 16, 10, 0, 0),
    type: 'pageview',
    visitor: 'v2',
    path: '/home',
    referrer: 'https://www.facebook.com/',
    // The wire shape: the tracker sends utm without the utm_ prefix.
    utm: { source: 'facebook', medium: 'social', campaign: 'iupc' },
  },

  // Dhaka 2026-09-17: v1 once, v3 twice.
  { ts: Date.UTC(2026, 8, 17, 3, 0, 0), type: 'pageview', visitor: 'v1', path: '/home' },
  {
    ts: Date.UTC(2026, 8, 17, 5, 0, 0),
    type: 'pageview',
    visitor: 'v3',
    path: '/docs',
    referrer: 'https://www.google.com/',
    status: NOT_FOUND_STATUS,
  },
  // A signup in the middle of a stay on a day that is rolled up, so a goal
  // read proves it reads raw rows across the rollup. On the page already open,
  // so no entry or exit moves.
  {
    ts: Date.UTC(2026, 8, 17, 5, 5, 0),
    type: 'event',
    visitor: 'v3',
    path: '/docs',
    name: SIGNUP,
    props: { plan: 'free' },
  },
  { ts: Date.UTC(2026, 8, 17, 5, 10, 0), type: 'pageview', visitor: 'v3', path: '/home' },

  // Dhaka 2026-09-18, today. The first one is the boundary: 00:30 in Dhaka,
  // still the 17th in UTC.
  { ts: BOUNDARY_TS, type: 'pageview', visitor: 'v1', path: '/home' },
  { ts: Date.UTC(2026, 8, 18, 3, 0, 0), type: 'identify', visitor: 'v1', userId: USER_ID },
  { ts: NOW - 600_000, type: 'pageview', visitor: 'v2', path: '/pricing' },
  // A page timing, which carries a name the way a custom event does and is not
  // one. Inside v2's stay and on the page already open, so no visit, entry or
  // exit moves; what it proves is that the event dimension leaves it out.
  { ts: NOW - 300_000, type: 'vital', visitor: 'v2', path: '/pricing', name: 'LCP', value: 1800 },
  {
    ts: Date.UTC(2026, 8, 18, 3, 30, 0),
    type: 'pageview',
    visitor: 'v3',
    path: '/docs',
    status: NOT_FOUND_STATUS,
  },
  // And another today, inside the same kind of stay, with a different plan so
  // the property breakdown has two values to tell apart.
  {
    ts: Date.UTC(2026, 8, 18, 3, 32, 0),
    type: 'event',
    visitor: 'v3',
    path: '/docs',
    name: SIGNUP,
    props: { plan: 'pro' },
  },
  { ts: Date.UTC(2026, 8, 18, 3, 35, 0), type: 'pageview', visitor: 'v3', path: '/pricing' },
  { ts: Date.UTC(2026, 8, 18, 3, 45, 0), type: 'pageview', visitor: 'bot', path: '/home' },
  { ts: Date.UTC(2026, 8, 18, 3, 50, 0), type: 'event', visitor: 'v1', name: SIGNUP, userId: USER_ID },

  // The last minute decides who is online: v2 is, v3 stopped 90 seconds ago.
  // A heartbeat moves the stay and the presence entry and is never stored, so
  // neither of these leaves a row behind; the leave beacon beside v3's does,
  // because the time on page and the scroll quartile are only recorded there.
  { ts: NOW - 30_000, type: 'heartbeat', visitor: 'v2', path: '/pricing' },
  { ts: NOW - 90_000, type: 'heartbeat', visitor: 'v3', path: '/pricing' },
  {
    ts: NOW - 90_000,
    type: 'leave',
    visitor: 'v3',
    path: '/pricing',
    duration: 90_000,
    scrollDepth: 75,
  },
];

function build(draft: Draft): StoredEvent {
  const profile = PROFILES[draft.visitor];
  const event: StoredEvent = {
    siteId: SITE_ID,
    ts: draft.ts,
    receivedAt: draft.ts,
    type: draft.type,
    visitorId: draft.visitor,
    bot: draft.visitor === 'bot',
    hostname: 'fixture.test',
    geo: { ...profile.geo },
    ua: { ...profile.ua },
    ip: profile.ip,
    lang: profile.lang,
    screen: profile.screen,
  };
  if (draft.userId !== undefined) event.userId = draft.userId;
  if (draft.path !== undefined) event.path = draft.path;
  if (draft.name !== undefined) event.name = draft.name;
  if (draft.referrer !== undefined) event.referrer = draft.referrer;
  if (draft.utm !== undefined) event.utm = { ...draft.utm };
  if (draft.duration !== undefined) event.duration = draft.duration;
  if (draft.scrollDepth !== undefined) event.scrollDepth = draft.scrollDepth;
  if (draft.status !== undefined) event.status = draft.status;
  if (draft.value !== undefined) event.value = draft.value;
  if (draft.props !== undefined) event.props = { ...draft.props };
  if (draft.type === 'identify') event.traits = { plan: 'pro' };
  return event;
}

export function fixtureEvents(): StoredEvent[] {
  return DRAFTS.map(build);
}

// One more beat from a visitor the fixture already knows, for the cases that
// prove a heartbeat moves the stay and leaves no row behind.
export function heartbeatOf(visitor: 'v1' | 'v2' | 'v3', ts: number, path: string): StoredEvent {
  return build({ ts, type: 'heartbeat', visitor, path });
}

// The counts the suite asserts against, stated rather than derived.
//
// The stays the gap rule cuts out of the drafts above, in the site's calendar:
//
//   16th  v1 03:00 to 03:05, two pages          v2 10:00, one page
//   17th  v1 03:00, one page                    v3 05:00 to 05:10, two pages
//   18th  v1 00:30 (the boundary), one page     v1 09:00 identify, no page
//         v1 09:50 signup, no page              v2 09:50 to 09:59, one page
//         v3 09:30 to 09:58, two pages          bot 09:45, one page
//
// v1's identify and signup are 50 minutes apart, so they are two stays and not
// one; v3's pageview and its heartbeat 28 minutes later are one.
export const EXPECTED = {
  dayBefore: { visitors: 2, pageviews: 3, visits: 2, bounces: 1, durationMs: 300_000 },
  yesterday: { visitors: 2, pageviews: 3, visits: 2, bounces: 1, durationMs: 600_000 },
  today: { visitors: 3, pageviews: 4, visits: 5, bounces: 4, durationMs: 2_280_000 },
  todayWithBots: { visitors: 4, pageviews: 5 },
} as const;

export const EXPECTED_RANGE = {
  visitors: EXPECTED.dayBefore.visitors + EXPECTED.yesterday.visitors + EXPECTED.today.visitors,
  pageviews: EXPECTED.dayBefore.pageviews + EXPECTED.yesterday.pageviews + EXPECTED.today.pageviews,
  visits: EXPECTED.dayBefore.visits + EXPECTED.yesterday.visits + EXPECTED.today.visits,
  bounces: EXPECTED.dayBefore.bounces + EXPECTED.yesterday.bounces + EXPECTED.today.bounces,
  durationMs:
    EXPECTED.dayBefore.durationMs + EXPECTED.yesterday.durationMs + EXPECTED.today.durationMs,
} as const;
