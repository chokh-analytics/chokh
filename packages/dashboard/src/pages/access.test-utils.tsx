import { QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import { vi } from 'vitest';

import { AppContext, type AppContextValue } from '../app/context.js';
import type { PublicSite } from '../lib/api.js';
import { createClient } from '../lib/client.js';
import { createQueryClient } from '../lib/queries.js';

// What the Team, Audit log and invitation page tests share: a site, a server
// made of one function, and the shell's context around a page.

export const NOW = Date.UTC(2026, 8, 24, 9, 0, 0);

export const SITE: PublicSite = {
  id: 's_test',
  name: 'Progsity',
  domains: ['progsity.io'],
  teamId: 't_own',
  settings: {
    ipMode: 'full',
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

export const OTHER_SITE: PublicSite = { ...SITE, id: 's_other', name: 'Blog', domains: ['blog.example'] };

export function ok(data: unknown, meta?: Record<string, unknown>): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({ success: true, data, ...(meta === undefined ? {} : { meta }) }),
  } as unknown as Response;
}

export function refused(status: number, code: string, message = code, details?: unknown): Response {
  return {
    status,
    ok: false,
    json: () =>
      Promise.resolve({
        success: false,
        error: { code, message, ...(details === undefined ? {} : { details }) },
      }),
  } as unknown as Response;
}

export interface Call {
  method: string;
  path: string;
  url: URL;
  body: unknown;
}

// A server that is one function: what was asked in, a response out. Anything
// it does not answer is a 404, so a request a test did not expect shows up as
// a failure and not as a hang.
export function serve(answer: (call: Call) => Response | undefined): () => Call[] {
  const calls: Call[] = [];
  const fetcher = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve(answer(call) ?? refused(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetcher);
  return () => calls;
}

export interface Who {
  // The role in the team that owns the site, or null for no place in it.
  team?: 'owner' | 'editor' | 'viewer' | null;
  // What GET /api/me said this person may do on the site.
  scopes?: string[];
  email?: string;
  // Every team this person is in, when the one that owns the site is not
  // the whole story.
  teams?: { id: string; name: string; role: 'owner' | 'editor' | 'viewer' }[];
}

const OWNER_SCOPES = ['admin', 'read:identity', 'read:stats', 'write:events'];

export function show(page: JSX.Element, who: Who = {}): JSX.Element {
  const team = who.team === undefined ? 'owner' : who.team;
  const scopes = who.scopes ?? (team === 'owner' ? OWNER_SCOPES : ['read:stats']);
  const site: PublicSite = { ...SITE, scopes };
  const value: AppContextValue = {
    client: createClient({ fetch: globalThis.fetch }),
    me: {
      actor: { kind: 'session', id: 'u_me' },
      user: { id: 'u_me', email: who.email ?? 'owner@test.example' },
      sites: [site, OTHER_SITE],
      teams: who.teams ?? (team === null ? [] : [{ id: 't_own', name: 'Ours', role: team }]),
    },
    site,
    now: NOW,
  };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <AppContext.Provider value={value}>{page}</AppContext.Provider>
    </QueryClientProvider>
  );
}
