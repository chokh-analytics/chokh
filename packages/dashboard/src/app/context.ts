import { createContext, useContext } from 'react';

import type { Goal } from '@chokh/store/contract';

import type { PublicSite, Me } from '../lib/api.js';
import type { Client } from '../lib/client.js';

// What every page needs and nothing decides for itself: who is signed in, which
// site is on screen, what time it is and how to reach the server.
//
// The clock is in here rather than read from Date.now() at call sites for one
// reason: every range in this dashboard is resolved against it, and a test that
// cannot state what time it is has to assert on ranges it computed the same way
// the code did, which proves nothing. The store made the same choice.

export interface AppContextValue {
  client: Client;
  me: Me;
  site: PublicSite;
  now: number;
  // The site's goals once they have answered. What vouches for a goal id in a
  // link: absent, and no goal in the URL is taken at its word.
  goals?: readonly Goal[];
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) {
    throw new Error('useApp was called outside the application shell');
  }
  return value;
}

// The zone every date in this dashboard is drawn in. Never the browser's: a
// site in Dhaka asking what happened today means its own midnight.
export function useTimezone(): string {
  return useApp().site.settings.timezone;
}

// Whether this person owns the team the site belongs to. Adding or removing a
// goal or a funnel changes what every report of the site says, so the server
// asks for the admin scope, which only an owner holds, and a page that draws
// those controls draws them disabled with the reason for anybody else.
export function isOwner(teams: readonly { id: string; role: string }[], teamId: string): boolean {
  return teams.some((team) => team.id === teamId && team.role === 'owner');
}
