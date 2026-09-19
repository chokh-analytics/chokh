import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Redirect, Route, Switch, useLocation, useParams, useSearch } from 'wouter';

import { createClient, type Client } from '../lib/client.js';
import { createQueryClient, useMe } from '../lib/queries.js';
import { FirstRun } from '../pages/FirstRun.js';
import { Devices } from '../pages/Devices.js';
import { Geo } from '../pages/Geo.js';
import { Overview } from '../pages/Overview.js';
import { People } from '../pages/People.js';
import { Pages } from '../pages/Pages.js';
import { Realtime } from '../pages/Realtime.js';
import { Sources } from '../pages/Sources.js';
import { SignIn } from '../pages/SignIn.js';
import { Splash } from '../ui/Splash.js';
import { Shell } from './Shell.js';
import { useNow } from './useNow.js';
import type { AppContextValue } from './context.js';

// Boot, in the order a browser can actually do it.
//
// Until GET /api/me answers, nobody knows whether this person is signed in,
// which site they are looking at, or whether there is a site at all, so what is
// on screen is the splash and not a skeleton of a dashboard: a page of grey
// rectangles would be a guess at a layout that may never appear. The moment it
// answers, exactly one of four things is true, and each has its own screen.

function SiteRoutes({ value }: { value: AppContextValue }): JSX.Element {
  return (
    <Switch>
      <Route path="/:siteId" component={Overview} />
      <Route path="/:siteId/realtime">
        <Realtime />
      </Route>
      <Route path="/:siteId/pages">
        <Pages />
      </Route>
      <Route path="/:siteId/sources">
        <Sources />
      </Route>
      <Route path="/:siteId/geo">
        <Geo />
      </Route>
      <Route path="/:siteId/devices">
        <Devices />
      </Route>
      <Route path="/:siteId/people">
        <People />
      </Route>
      {/*
        Two segments, and both of them matter: a visitor id is a browser and a
        user id is a person your application named, and the server treats the
        two lookups differently.
      */}
      <Route path="/:siteId/people/:kind/:id">
        <People />
      </Route>
      {/* Anything else under a site is a link somebody mistyped, and the
          navigation is still there to get them out of it. */}
      <Route>
        <Redirect to={`/${value.site.id}`} replace />
      </Route>
    </Switch>
  );
}

// Which site the path names, or the first one this account can read. A path
// naming a site that is not theirs falls back rather than refusing: the site
// switcher is right there, and a bare refusal for a link somebody was sent is a
// dead end.
function SiteFrame({
  value,
  onSignedOut,
}: {
  value: Omit<AppContextValue, 'site'> & { sites: AppContextValue['me']['sites'] };
  onSignedOut: () => void;
}): JSX.Element {
  const params = useParams<{ siteId?: string }>();
  const site = value.sites.find((candidate) => candidate.id === params.siteId) ?? value.sites[0];
  if (site === undefined) {
    throw new Error('SiteFrame rendered with no sites');
  }
  const context: AppContextValue = { ...value, site };

  return (
    <Shell value={context} onSignedOut={onSignedOut}>
      <SiteRoutes value={context} />
    </Shell>
  );
}

// Where /login sends somebody back to. Only ever a path of this dashboard,
// because a next that leaves it is how a trusted link becomes a phishing link,
// which is the rule the SSO exchange keeps on the server.
export function safeNext(next: string | null): string | null {
  if (next === null || !next.startsWith('/') || next.startsWith('//')) {
    return null;
  }
  return next.startsWith('/login') ? null : next;
}

function Authenticated({
  client,
  onExpired,
}: {
  client: Client;
  onExpired: { current: () => void };
}): JSX.Element {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const queryClient = useQueryClient();
  const me = useMe(client);
  const now = useNow();
  const [mode, setMode] = useState<'signIn' | 'register'>('signIn');

  // What a 401 from anywhere does, wired to the client the moment this renders.
  //
  // It has to live here and not in App, because it needs the router: the whole
  // point is that somebody whose session expired halfway through a report lands
  // on the sign in page and comes back to the report they were reading, rather
  // than looking at a page of cards that each say UNAUTHENTICATED.
  useEffect(() => {
    onExpired.current = () => {
      // Only when somebody was signed in a moment ago. A 401 on the very first
      // GET /api/me is the ordinary signed out path, and clearing the cache
      // there restarts the query that just failed, for ever.
      if (queryClient.getQueryData(['me']) === undefined) {
        return;
      }
      const here = `${location}${search === '' ? '' : `?${search}`}`;
      // Everything cached belongs to the session that has just ended.
      queryClient.clear();
      if (safeNext(here) !== null) {
        navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
      }
    };
  }, [onExpired, location, search, navigate, queryClient]);

  const signedOut = useCallback(() => {
    // Everything in the cache belongs to the person who has just left,
    // including addresses the next person at this browser may not read. Clearing
    // it is not tidiness: without it the next account signing in at this
    // browser is served the previous person's rows while their own load.
    queryClient.clear();
    navigate('/login');
  }, [navigate, queryClient]);

  const signedIn = useCallback(() => {
    const next = safeNext(new URLSearchParams(search).get('next'));
    void me.refetch();
    if (next !== null) {
      navigate(next, { replace: true });
    }
  }, [me, navigate, search]);

  if (me.isPending) {
    return <Splash />;
  }

  if (me.isError || me.data === undefined) {
    return <SignIn client={client} mode={mode} onModeChange={setMode} onSignedIn={signedIn} />;
  }

  const value = { client, me: me.data.data, now, sites: me.data.data.sites };

  if (value.sites.length === 0) {
    return (
      <FirstRun
        client={client}
        teams={value.me.teams}
        onReady={() => void me.refetch()}
      />
    );
  }

  const home = `/${value.sites[0]?.id ?? ''}`;

  return (
    <Switch>
      {/* A person who is already signed in and lands on /login has followed a
          stale link or pressed back. Sending them to their numbers is better
          than showing them a form they do not need, and to the report the link
          carried if it carried one: that is the other half of what next is for,
          because a session can come back before the form is ever submitted. */}
      <Route path="/login">
        <Redirect to={safeNext(new URLSearchParams(search).get('next')) ?? home} replace />
      </Route>
      {/*
        Two patterns and not one, and the second is an unnamed wildcard.
        
        A wildcard segment does not match its own absence, so a single pattern
        misses the site root, which is the most visited path in the product:
        the fallback below then redirects it to itself for ever and the page
        renders nothing at all. And a named wildcard, /:siteId/:rest*, matches
        exactly one segment, so a profile link four deep matched nothing and
        opened the Overview instead. Both failures are silent, which is why
        both are named here and both have a test.
      */}
      <Route path="/:siteId">
        <SiteFrame value={value} onSignedOut={signedOut} />
      </Route>
      <Route path="/:siteId/*">
        <SiteFrame value={value} onSignedOut={signedOut} />
      </Route>
      <Route>
        <Redirect to={home} replace />
      </Route>
    </Switch>
  );
}

export function App(): JSX.Element {
  const queryClient = useMemo(() => createQueryClient(), []);
  // A box the router fills in, because the client is built once and outside
  // every router hook, and what a 401 should do is a navigation.
  const onExpired = useRef<() => void>(() => {});
  const client = useMemo(
    () =>
      createClient({
        // In production the dashboard is served by the API, so the base is
        // empty and every request is same origin. A dev server points it at the
        // collector instead.
        baseUrl: import.meta.env.VITE_API_URL ?? '',
        // One decision for the whole application: a session that has expired
        // mid visit puts the person back on the sign in page rather than
        // leaving every card to fail on its own.
        onUnauthenticated: () => onExpired.current(),
      }),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <Authenticated client={client} onExpired={onExpired} />
    </QueryClientProvider>
  );
}
