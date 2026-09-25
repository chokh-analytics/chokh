import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Redirect, Route, Switch, useLocation, useParams, useSearch } from 'wouter';

import { createClient, type Client } from '../lib/client.js';
import { requestedGoal, requestedVs } from '../lib/query.js';
import { createQueryClient, useGoals, useMe, useSegments } from '../lib/queries.js';
import { messages } from '../messages/en.js';
import { FirstRun } from '../pages/FirstRun.js';
import { Overview } from '../pages/Overview.js';
import { SignIn } from '../pages/SignIn.js';
import { Splash } from '../ui/Splash.js';
import { Skeleton } from '../ui/State.js';
import { Shell } from './Shell.js';
import { useNow } from './useNow.js';
import type { AppContextValue } from './context.js';

// One chunk per report, and the Overview is not one of them.
//
// The Overview is the page every visit starts on, so lazily loading it would
// buy a round trip and spend it immediately. Everything else is a page some
// visits never open, and two of them carry the world map, which is forty
// kilobytes of coastline that has no business reaching the sign-in screen.
// Rollup puts the map in a chunk of its own because both of those import it,
// so it is downloaded once by whichever is opened first and not at all by
// somebody who opens neither.
const Realtime = lazy(async () => ({ default: (await import('../pages/Realtime.js')).Realtime }));
const Pages = lazy(async () => ({ default: (await import('../pages/Pages.js')).Pages }));
const Sources = lazy(async () => ({ default: (await import('../pages/Sources.js')).Sources }));
const Geo = lazy(async () => ({ default: (await import('../pages/Geo.js')).Geo }));
const Devices = lazy(async () => ({ default: (await import('../pages/Devices.js')).Devices }));
const Events = lazy(async () => ({ default: (await import('../pages/Events.js')).Events }));
const Goals = lazy(async () => ({ default: (await import('../pages/Goals.js')).Goals }));
const Funnels = lazy(async () => ({ default: (await import('../pages/Funnels.js')).Funnels }));
const People = lazy(async () => ({ default: (await import('../pages/People.js')).People }));
const Alerts = lazy(async () => ({ default: (await import('../pages/Alerts.js')).Alerts }));
const Settings = lazy(async () => ({
  default: (await import('../pages/Settings.js')).Settings,
}));
// The shared page (AN-RPT01): outside the boot below, because whoever holds
// the link has no session and GET /api/me would send them to sign in.
const Share = lazy(async () => ({ default: (await import('../pages/Share.js')).Share }));

// What is on screen while a report's chunk is on its way.
//
// A rectangle the height of a report rather than a spinner or a blank: the
// navigation and the range bar are already drawn, so the only thing missing is
// the report, and the shape that is coming is the honest thing to draw. Named
// for a screen reader, because a silent swap is a page that changed without
// saying so.
function Loading(): JSX.Element {
  return (
    <div role="status" aria-label={messages.a11y.loadingRegion}>
      <Skeleton height={420} />
    </div>
  );
}

// Boot, in the order a browser can actually do it.
//
// Until GET /api/me answers, nobody knows whether this person is signed in,
// which site they are looking at, or whether there is a site at all, so what is
// on screen is the splash and not a skeleton of a dashboard: a page of grey
// rectangles would be a guess at a layout that may never appear. The moment it
// answers, exactly one of four things is true, and each has its own screen.

function SiteRoutes({ value }: { value: AppContextValue }): JSX.Element {
  return (
    <Suspense fallback={<Loading />}>
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
        <Route path="/:siteId/events">
          <Events />
        </Route>
        <Route path="/:siteId/goals">
          <Goals />
        </Route>
        <Route path="/:siteId/funnels">
          <Funnels />
        </Route>
        <Route path="/:siteId/people">
          <People />
        </Route>
        <Route path="/:siteId/alerts">
          <Alerts />
        </Route>
        {/* Reached from the site menu rather than the report navigation: it is
            about the site, not a report of it. */}
        <Route path="/:siteId/settings">
          <Settings />
        </Route>
        {/*
          Two segments, and both of them matter: a visitor id is a browser and
          a user id is a person your application named, and the server treats
          the two lookups differently.
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
    </Suspense>
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
  const search = useSearch();
  const site = value.sites.find((candidate) => candidate.id === params.siteId) ?? value.sites[0];
  if (site === undefined) {
    throw new Error('SiteFrame rendered with no sites');
  }
  const goals = useGoals(value.client, site.id);
  const segments = useSegments(value.client, site.id);
  const context: AppContextValue = {
    ...value,
    site,
    ...(goals.data === undefined ? {} : { goals: goals.data.data.goals }),
    ...(segments.data === undefined ? {} : { segments: segments.data.data.segments }),
  };
  // A link that names a goal waits for the list before any report asks for a
  // number. Without the wait every card would ask twice, once without the goal
  // and once with it, or ask with a goal that was deleted since the link was
  // sent and draw a page of errors before the list could say so. A link with
  // no goal in it waits for nothing. A link comparing against a segment waits
  // for the segment list for the same reason.
  const waiting =
    (requestedGoal(search) !== null && goals.isPending) ||
    (requestedVs(search) !== null && segments.isPending);

  return (
    <Shell value={context} onSignedOut={onSignedOut}>
      {waiting ? <Loading /> : <SiteRoutes value={context} />}
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

  // Where somebody with no session lands.
  //
  // At /login, carrying where they were going, and never at the report's own
  // URL with a form drawn over it: that page cannot be linked to, a reload
  // lands on the form again, and the sign-in afterwards has nothing to tell it
  // where to go. The redirect replaces rather than pushes, because nobody
  // wants to press back into a page they were never shown.
  const unauthenticated = !me.isPending && (me.isError || me.data === undefined);
  const onLogin = location === '/login';

  useEffect(() => {
    if (!unauthenticated || onLogin) {
      return;
    }
    const here = `${location}${search === '' ? '' : `?${search}`}`;
    const next = safeNext(here);
    navigate(next === null || next === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`, {
      replace: true,
    });
  }, [unauthenticated, onLogin, location, search, navigate]);

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

  if (unauthenticated) {
    // The effect above is sending them to /login. Until the URL changes this
    // renders the splash rather than the form, so the form is only ever drawn
    // at the one address it can be linked to.
    return onLogin ? (
      <SignIn client={client} mode={mode} onModeChange={setMode} onSignedIn={signedIn} />
    ) : (
      <Splash />
    );
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
      <Switch>
        <Route path="/share/:token">
          {(params: { token: string }) => (
            <Suspense fallback={<Splash />}>
              <Share client={client} token={params.token} />
            </Suspense>
          )}
        </Route>
        <Route>
          <Authenticated client={client} onExpired={onExpired} />
        </Route>
      </Switch>
    </QueryClientProvider>
  );
}
