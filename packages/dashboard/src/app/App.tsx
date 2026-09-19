import { useCallback, useMemo, useState, type JSX } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Route, Switch, useLocation, useParams } from 'wouter';

import { createClient, type Client } from '../lib/client.js';
import { createQueryClient, useMe } from '../lib/queries.js';
import { messages } from '../messages/en.js';
import { FirstRun } from '../pages/FirstRun.js';
import { SignIn } from '../pages/SignIn.js';
import { Splash } from '../ui/Splash.js';
import { Shell } from './Shell.js';
import type { AppContextValue } from './context.js';

// Boot, in the order a browser can actually do it.
//
// Until GET /api/me answers, nobody knows whether this person is signed in,
// which site they are looking at, or whether there is a site at all, so what is
// on screen is the splash and not a skeleton of a dashboard: a page of grey
// rectangles would be a guess at a layout that may never appear. The moment it
// answers, exactly one of four things is true, and each has its own screen.

function Placeholder({ title }: { title: string }): JSX.Element {
  // The seven reports arrive in the commits after this one. Until then a
  // destination that exists in the navigation renders its own name rather than
  // nothing, so the shell can be walked and judged before there is a chart in
  // it.
  return <h1>{title}</h1>;
}

function SiteRoutes({ value }: { value: AppContextValue }): JSX.Element {
  return (
    <Switch>
      <Route path="/:siteId" component={() => <Placeholder title={messages.overview.title} />} />
      <Route
        path="/:siteId/realtime"
        component={() => <Placeholder title={messages.nav.realtime} />}
      />
      <Route path="/:siteId/pages" component={() => <Placeholder title={messages.nav.pages} />} />
      <Route
        path="/:siteId/sources"
        component={() => <Placeholder title={messages.nav.sources} />}
      />
      <Route path="/:siteId/geo" component={() => <Placeholder title={messages.nav.geo} />} />
      <Route
        path="/:siteId/devices"
        component={() => <Placeholder title={messages.nav.devices} />}
      />
      <Route path="/:siteId/people" component={() => <Placeholder title={messages.nav.people} />} />
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

function Authenticated({ client }: { client: Client }): JSX.Element {
  const [, navigate] = useLocation();
  const me = useMe(client);
  const [mode, setMode] = useState<'signIn' | 'register'>('signIn');

  const signedOut = useCallback(() => {
    // Everything in the cache belongs to the person who has just left,
    // including addresses the next person at this browser may not read.
    void me.refetch();
    navigate('/login');
  }, [me, navigate]);

  if (me.isPending) {
    return <Splash />;
  }

  if (me.isError || me.data === undefined) {
    return (
      <SignIn
        client={client}
        mode={mode}
        onModeChange={setMode}
        onSignedIn={() => void me.refetch()}
      />
    );
  }

  const value = { client, me: me.data.data, now: Date.now(), sites: me.data.data.sites };

  if (value.sites.length === 0) {
    return <FirstRun client={client} onReady={() => void me.refetch()} />;
  }

  const home = `/${value.sites[0]?.id ?? ''}`;

  return (
    <Switch>
      {/* A person who is already signed in and lands on /login has followed a
          stale link or pressed back. Sending them to their numbers is better
          than showing them a form they do not need. */}
      <Route path="/login">
        <Redirect to={home} replace />
      </Route>
      {/*
        Two patterns and not one. A wildcard segment does not match its own
        absence, so /:siteId/:rest* misses the site root, which is the most
        visited path in the product: the fallback below would then redirect it
        to itself for ever and the page would render nothing at all. Named
        twice, because that failure is silent.
      */}
      <Route path="/:siteId">
        <SiteFrame value={value} onSignedOut={signedOut} />
      </Route>
      <Route path="/:siteId/:rest*">
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
  const client = useMemo(
    () =>
      createClient({
        // In production the dashboard is served by the API, so the base is
        // empty and every request is same origin. A dev server points it at the
        // collector instead.
        baseUrl: import.meta.env.VITE_API_URL ?? '',
        onUnauthenticated: () => {
          // One decision for the whole application: a session that has expired
          // mid visit puts the person back on the sign in page rather than
          // leaving every card to fail on its own.
          queryClient.setQueryData(['me'], undefined);
        },
      }),
    [queryClient],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <Authenticated client={client} />
    </QueryClientProvider>
  );
}
