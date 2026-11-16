import type { CoverageResult, ErrorsResult, VitalsResult } from '@chokh/store/health';
import type {
  ActivityResult,
  AttributionResult,
  CohortResult,
  PeopleList,
  PowerUsersResult,
} from '@chokh/store/contract';
import { describe, expect, it } from 'vitest';

import { answer } from '../../e2e/fixture-answers.mjs';
import { api } from '../lib/api.js';
import { createClient, type Answer, type Client } from '../lib/client.js';
import { healthWindow } from '../pages/Health.js';
import { cohortWindow, daysWindow } from '../pages/Retention.js';

// Every read the dashboard can make, answered by the demo's fixture through
// the dashboard's own client, as the demo answers it in the page. A route the
// fixture does not answer is a page of the public demo that draws an error
// card ("Nothing answers ..."), so a read with no answer fails here, and so
// does a new read in lib/api.ts that nobody has given a case: the reads are
// found by calling every function of `api`, not by a list kept beside it.
//
// The retention and health windows are the pages' own, at two clocks: the
// frozen one the screenshots are taken at, and a day two months later, as a
// reader of the demo opens it.

const SITE = 's_demo';
const TZ = 'Asia/Dhaka';
const CLOCKS = [
  ['the pictures', Date.UTC(2026, 8, 18, 9, 30)],
  ['a later day', Date.UTC(2026, 10, 16, 11, 0)],
] as const;

interface Sent {
  method: string;
  path: string;
}

// The dashboard's client over the fixture: a read is answered as the demo
// answers it, anything else is refused, and every request is written down.
function fixtureClient(): { client: Client; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = createClient({
    fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://demo.example');
      const method = (init?.method ?? 'GET').toUpperCase();
      sent.push({ method, path: url.pathname });
      const found =
        method === 'GET'
          ? answer(url.pathname, url.searchParams, { licensed: true })
          : { status: 403, body: { success: false, error: { code: 'DEMO_READ_ONLY', message: 'demo' } } };
      return Promise.resolve(
        new Response(JSON.stringify(found.body), {
          status: found.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
  return { client, sent };
}

type Read = [label: string, call: (client: Client) => Promise<Answer<unknown>>, check?: (answer: Answer<unknown>) => void];

const SCOPE_SITE = { kind: 'site', id: SITE } as const;
const SCOPE_TEAM = { kind: 'team', id: 'default' } as const;
const RANGE = { from: Date.UTC(2026, 8, 11, 18), to: Date.UTC(2026, 8, 18, 18) };

// Every GET of lib/api.ts, by its name there, with the cases its pages ask.
function reads(now: number): Record<string, Read[]> {
  const week = cohortWindow(now, 'week', TZ);
  const month = cohortWindow(now, 'month', TZ);
  const days30 = daysWindow(now, 30, TZ);
  const days90 = daysWindow(now, 90, TZ);
  const health = [7, 28, 90].map((days) => healthWindow(now, days, TZ));

  const cohorts = (answer: Answer<unknown>): void => {
    const result = answer.data as CohortResult;
    expect(result.cohorts.length).toBeGreaterThan(1);
    expect(result.cohorts[0]?.periods.length).toBeGreaterThan(1);
    expect(result.cohorts.every((cohort) => cohort.visitors > 0)).toBe(true);
  };
  const activity = (answer: Answer<unknown>): void => {
    const result = answer.data as ActivityResult;
    expect(result.days.length).toBeGreaterThanOrEqual(30);
    expect(result.curve.length).toBe(result.days.length);
    expect(result.stickiness).not.toBeNull();
    expect(result.powerUsers).toBeGreaterThan(0);
    // The curve holds the days' visitors, each person once per day.
    const personDays = result.curve.reduce((sum, count, index) => sum + count * (index + 1), 0);
    const dau = result.days.reduce((sum, day) => sum + day.dau, 0);
    expect(Math.abs(personDays - dau) / dau).toBeLessThan(0.02);
  };
  const attribution = (answer: Answer<unknown>): void => {
    const result = answer.data as AttributionResult;
    expect(result.rows.length).toBeGreaterThan(1);
    // Each column adds up to the converters above it, as the store's do.
    for (const column of ['first', 'last'] as const) {
      expect(result.rows.reduce((sum, row) => sum + row[column].visitors, 0)).toBe(result.visitors);
      expect(result.rows.reduce((sum, row) => sum + row[column].completions, 0)).toBe(result.completions);
    }
  };
  const vitals = (answer: Answer<unknown>): void => {
    const result = answer.data as VitalsResult;
    expect(result.metrics.map((metric) => metric.metric)).toEqual(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);
    expect(result.metrics.every((metric) => metric.p75 !== null)).toBe(true);
    expect(result.pages.length).toBeGreaterThan(3);
  };
  const errors = (answer: Answer<unknown>): void => {
    const result = answer.data as ErrorsResult;
    expect(result.groups.length).toBeGreaterThan(1);
    // Collected, or the page says nothing is.
    expect(answer.meta?.errorCapture).toBe(true);
    // Never a sample in the reader's future.
    expect(result.groups.every((group) => group.lastSeen < now)).toBe(true);
  };
  const coverage = (answer: Answer<unknown>): void => {
    expect((answer.data as CoverageResult).state).toBe('ok');
  };
  const people = (count: (rows: PeopleList['people']) => boolean) => (answer: Answer<unknown>) => {
    const result = answer.data as PeopleList;
    expect(result.people.length).toBeGreaterThan(0);
    expect(count(result.people)).toBe(true);
  };

  return {
    me: [['me', (client) => api.me(client)]],
    license: [['license', (client) => api.license(client)]],
    aggregate: [['aggregate', (client) => api.aggregate(client, SITE, RANGE)]],
    timeseries: [['timeseries', (client) => api.timeseries(client, SITE, RANGE)]],
    breakdown: [['breakdown', (client) => api.breakdown(client, SITE, { ...RANGE, dim: 'page' })]],
    engagement: [['engagement', (client) => api.engagement(client, SITE, RANGE)]],
    goals: [['goals', (client) => api.goals(client, SITE)]],
    segments: [['segments', (client) => api.segments(client, SITE)]],
    annotations: [['annotations', (client) => api.annotations(client, SITE, 1, 2)]],
    alerts: [['alerts', (client) => api.alerts(client, SITE)]],
    digests: [['digests', (client) => api.digests(client, SITE)]],
    funnels: [['funnels', (client) => api.funnels(client, SITE)]],
    funnelStats: [['a funnel', (client) => api.funnelStats(client, SITE, RANGE, 'f_course')]],
    journeys: [['journeys', (client) => api.journeys(client, SITE, RANGE, 5)]],
    goalStats: [['the goals', (client) => api.goalStats(client, SITE, RANGE)]],
    events: [['events', (client) => api.events(client, SITE, RANGE)]],
    properties: [['properties', (client) => api.properties(client, SITE, RANGE, 'signup', null)]],
    cohorts: [
      ['weekly cohorts', (client) => api.cohorts(client, SITE, week, 'week'), cohorts],
      ['monthly cohorts', (client) => api.cohorts(client, SITE, month, 'month'), cohorts],
    ],
    activity: [
      ['30 days of activity', (client) => api.activity(client, SITE, days30), activity],
      ['90 days of activity', (client) => api.activity(client, SITE, days90), activity],
    ],
    powerUsers: [
      [
        'the most active',
        (client) => api.powerUsers(client, SITE, days30, 20),
        (answer) => {
          const result = answer.data as PowerUsersResult;
          expect(result.people.length).toBeGreaterThan(5);
          expect(result.people.every((row) => row.activeDays >= result.minDays)).toBe(true);
        },
      ],
    ],
    attribution: [
      ['signups by channel', (client) => api.attribution(client, SITE, days30, 'g_signup', 'channel'), attribution],
      ['checkouts by entry page', (client) => api.attribution(client, SITE, days90, 'g_checkout', 'entry'), attribution],
      ['signups by campaign', (client) => api.attribution(client, SITE, days30, 'g_signup', 'utm_campaign'), attribution],
    ],
    vitals: [
      ...health.map((window): Read => ['vitals', (client) => api.vitals(client, SITE, window, null, 'LCP'), vitals]),
      ['vitals on phones by INP', (client) => api.vitals(client, SITE, health[1]!, 'mobile', 'INP'), vitals],
    ],
    errors: health.map((window): Read => ['errors', (client) => api.errors(client, SITE, window), errors]),
    coverage: health.map((window): Read => ['coverage', (client) => api.coverage(client, SITE, window), coverage]),
    realtime: [['realtime', (client) => api.realtime(client, SITE)]],
    people: [
      ['the directory', (client) => api.people(client, SITE, { identifiedOnly: false, q: '' }), people(() => true)],
      [
        'the identified',
        (client) => api.people(client, SITE, { identifiedOnly: true, q: '' }),
        people((rows) => rows.every((row) => row.userId !== undefined)),
      ],
      [
        'a search',
        (client) => api.people(client, SITE, { identifiedOnly: false, q: 'quayle' }),
        people((rows) => rows.length === 1 && rows[0]?.traits?.name === 'Lena Quayle'),
      ],
    ],
    visitor: [['a profile', (client) => api.visitor(client, SITE, 'v_abcdef0001')]],
    share: [['the share', (client) => api.share(client, 'tok_demo')]],
    teamMembers: [['the team', (client) => api.teamMembers(client, 'default')]],
    siteMembers: [['the site', (client) => api.siteMembers(client, SITE)]],
    invitations: [
      ["the site's invitations", (client) => api.invitations(client, SCOPE_SITE)],
      ["the team's invitations", (client) => api.invitations(client, SCOPE_TEAM)],
    ],
    oidcStatus: [['sign-on', (client) => api.oidcStatus(client)]],
    oidcIdentity: [['the connection', (client) => api.oidcIdentity(client)]],
    audit: [
      ["the site's log", (client) => api.audit(client, SCOPE_SITE, {})],
      ["the team's log", (client) => api.audit(client, SCOPE_TEAM, {})],
    ],
  };
}

// Reads the demo refuses on purpose: a lookup by userId names a person, and
// the demo shows that refusal as the page draws it for a key without
// read:identity.
const REFUSED = new Set(['user']);

describe("the demo's fixture", () => {
  for (const [clock, now] of CLOCKS) {
    describe(`at ${clock}`, () => {
      for (const [name, cases] of Object.entries(reads(now))) {
        for (const [label, call, check] of cases) {
          it(`answers ${label} (api.${name})`, async () => {
            const { client } = fixtureClient();
            const got = await call(client);
            expect(got.data).toBeDefined();
            check?.(got);
          });
        }
      }
    });
  }

  it('has a case for every read in lib/api.ts', async () => {
    const known = reads(CLOCKS[0][1]);
    const unread: string[] = [];
    for (const [name, fn] of Object.entries(api)) {
      if (name in known || REFUSED.has(name)) continue;
      const { client, sent } = fixtureClient();
      try {
        await (fn as (...args: unknown[]) => unknown)(client, SITE, 'x', {});
      } catch {
        // A write the demo refuses, which is what it should do.
      }
      if (sent.some((request) => request.method === 'GET')) unread.push(name);
    }
    // A read listed here is a page of the demo nobody checked: give it a case
    // above and an answer in e2e/fixture-answers.mjs.
    expect(unread).toEqual([]);
    for (const name of [...Object.keys(known), ...REFUSED]) {
      expect(api).toHaveProperty(name);
    }
  });

  it('refuses the userId lookup as a key without read:identity is refused', async () => {
    const { client } = fixtureClient();
    await expect(api.user(client, SITE, 'u_42')).rejects.toMatchObject({ status: 403 });
  });
});
