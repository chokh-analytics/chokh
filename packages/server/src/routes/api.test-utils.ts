import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.js';
import { createApiKey } from '../services/keys.service.js';
import { createMemoryBus, type Bus } from '../services/bus.js';
import { createMemoryOnce, type OnceOnly } from '../services/once.js';
import { createMemoryStore, type MemoryStore } from '../store/memory.store.js';
import { defaultSiteSettings, type Role, type Scope, type Site } from '../store/AnalyticsStore.js';

// One app, one memory store, and an easy way to be somebody.
//
// Every route test in this directory builds the same install: one site, one owner,
// and whatever other accounts the case needs. Put here rather than repeated, so a
// test reads as the case it is about and "what does a viewer see" is one line rather
// than six of setup.

export const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
export const SITE_ID = 's_test';
export const TEAM_ID = 't_test';
export const OWNER_EMAIL = 'owner@test.example';
export const PASSWORD = 'a-password-long-enough';

export interface Harness {
  app: FastifyInstance;
  store: MemoryStore;
  bus: Bus;
  once: OnceOnly;
  now(): number;
  setNow(at: number): void;
  close(): Promise<void>;
  // The owner of the test team, created with the install.
  owner: { cookie: string; userId: string };
  // Another account with a role in a team, and the cookie to be them.
  account(input: {
    email: string;
    role: Role;
    identity?: boolean;
    teamId?: string;
  }): Promise<{ cookie: string; userId: string }>;
  signIn(email: string, password?: string): Promise<string>;
  // A key on a site, as an Authorization header value.
  key(scopes: Scope[], siteId?: string): Promise<string>;
}

export function testSite(overrides: Partial<Site> = {}): Site {
  return {
    id: SITE_ID,
    name: 'Test site',
    domains: ['test.example'],
    teamId: TEAM_ID,
    settings: defaultSiteSettings({ timezone: 'UTC', identifySecret: 'test-identify-secret' }),
    ...overrides,
  };
}

// An app with nothing in it: no site, no account, no team. What a fresh install is,
// for the tests about the very first registration.
export async function createBareApp(options: { bus?: Bus; once?: OnceOnly } = {}): Promise<{
  app: FastifyInstance;
  store: MemoryStore;
  bus: Bus;
  once: OnceOnly;
  now(): number;
  setNow(at: number): void;
  close(): Promise<void>;
}> {
  let at = NOW;
  const now = (): number => at;
  const store = createMemoryStore([], { now });
  // The app is handed the same bus and set the test holds, or a realtime test
  // would publish on one bus and watch another.
  const bus = options.bus ?? createMemoryBus();
  const once = options.once ?? createMemoryOnce(now);
  const app = await buildApp({ store, bus, once, now });
  await app.ready();
  return {
    app,
    store,
    bus,
    once,
    now,
    setNow: (next: number) => {
      at = next;
    },
    close: () => app.close(),
  };
}

function cookieHeader(response: { cookies: { name: string; value: string }[] }): string {
  const cookie = response.cookies[0];
  if (cookie === undefined) {
    throw new Error('no cookie was set');
  }
  return `${cookie.name}=${cookie.value}`;
}

export async function createHarness(options: { sites?: Site[] } = {}): Promise<Harness> {
  const bare = await createBareApp();
  const { app, store, bus, once } = bare;

  for (const site of options.sites ?? [testSite()]) {
    await store.createSite(site);
  }
  await store.createTeam({ id: TEAM_ID, name: 'Test team', members: [] });

  async function signIn(email: string, password = PASSWORD): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    if (response.statusCode !== 200) {
      throw new Error(`signIn(${email}) answered ${response.statusCode}: ${response.body}`);
    }
    return cookieHeader(response);
  }

  async function register(email: string, authorisedBy?: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD },
      ...(authorisedBy === undefined ? {} : { headers: { cookie: authorisedBy } }),
    });
    if (response.statusCode !== 201) {
      throw new Error(`register(${email}) answered ${response.statusCode}: ${response.body}`);
    }
    const body = JSON.parse(response.body) as { data: { user: { id: string } } };
    return body.data.user.id;
  }

  // The first account, which the register route makes an owner of the default team.
  // Made an owner of the test team as well, because that is what the test site
  // belongs to.
  const ownerId = await register(OWNER_EMAIL);
  await store.setTeamMember(TEAM_ID, { userId: ownerId, role: 'owner', identity: true });
  const ownerCookie = await signIn(OWNER_EMAIL);

  return {
    app,
    store,
    bus,
    once,
    now: bare.now,
    setNow: bare.setNow,
    close: bare.close,
    owner: { cookie: ownerCookie, userId: ownerId },
    signIn,

    async account(input) {
      const userId = await register(input.email, ownerCookie);
      await store.setTeamMember(input.teamId ?? TEAM_ID, {
        userId,
        role: input.role,
        identity: input.identity ?? false,
      });
      return { cookie: await signIn(input.email), userId };
    },

    async key(scopes: Scope[], siteId = SITE_ID) {
      const minted = await createApiKey(store, {
        siteId,
        name: scopes.join(' '),
        scopes,
        createdBy: ownerId,
        now: bare.now(),
      });
      return `Bearer ${minted.token}`;
    },
  };
}

export interface Envelope<T> {
  success: boolean;
  data?: T;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export function envelope<T>(body: string): Envelope<T> {
  return JSON.parse(body) as Envelope<T>;
}

// Every refusal in this API is the envelope, including 401 and 403. Asserted here
// so every route test can say it in one line and none of them forgets to.
export function expectFailure(
  response: { statusCode: number; body: string },
  status: number,
  code: string,
): void {
  const parsed = envelope<unknown>(response.body);
  if (response.statusCode !== status || parsed.success !== false || parsed.error?.code !== code) {
    throw new Error(
      `expected ${status} ${code}, got ${response.statusCode} ${response.body.slice(0, 200)}`,
    );
  }
}
