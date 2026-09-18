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
const KOLKATA = { country: 'IN', region: 'West Bengal', city: 'Kolkata', tz: 'Asia/Kolkata' };

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
}

const PROFILES = {
  v1: { userId: 'u_rafi', geo: DHAKA, ua: ANDROID, ip: '103.87.12.9', lang: 'bn', screen: '412x915' },
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
  },
  { ts: Date.UTC(2026, 8, 17, 5, 10, 0), type: 'pageview', visitor: 'v3', path: '/home' },

  // Dhaka 2026-09-18, today. The first one is the boundary: 00:30 in Dhaka,
  // still the 17th in UTC.
  { ts: BOUNDARY_TS, type: 'pageview', visitor: 'v1', path: '/home' },
  { ts: Date.UTC(2026, 8, 18, 3, 0, 0), type: 'identify', visitor: 'v1' },
  { ts: NOW - 600_000, type: 'pageview', visitor: 'v2', path: '/pricing' },
  { ts: Date.UTC(2026, 8, 18, 3, 30, 0), type: 'pageview', visitor: 'v3', path: '/docs' },
  { ts: Date.UTC(2026, 8, 18, 3, 45, 0), type: 'pageview', visitor: 'bot', path: '/home' },
  { ts: Date.UTC(2026, 8, 18, 3, 50, 0), type: 'event', visitor: 'v1', name: 'signup' },

  // The last minute decides who is online: v2 is, v3 stopped 90 seconds ago.
  { ts: NOW - 30_000, type: 'heartbeat', visitor: 'v2', path: '/pricing' },
  { ts: NOW - 90_000, type: 'heartbeat', visitor: 'v3', path: '/docs' },
];

export function fixtureEvents(): StoredEvent[] {
  return DRAFTS.map((draft) => {
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
    if ('userId' in profile) {
      event.userId = profile.userId;
    }
    if (draft.path !== undefined) event.path = draft.path;
    if (draft.name !== undefined) event.name = draft.name;
    if (draft.referrer !== undefined) event.referrer = draft.referrer;
    if (draft.utm !== undefined) event.utm = { ...draft.utm };
    if (draft.type === 'identify') event.traits = { plan: 'pro' };
    return event;
  });
}

// The pageview counts the suite asserts against, stated rather than derived.
export const EXPECTED = {
  dayBefore: { visitors: 2, pageviews: 3 },
  yesterday: { visitors: 2, pageviews: 3 },
  today: { visitors: 3, pageviews: 3 },
  todayWithBots: { visitors: 4, pageviews: 4 },
} as const;
