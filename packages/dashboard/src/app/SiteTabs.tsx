import type { JSX } from 'react';
import { Link, useRoute } from 'wouter';

import { messages } from '../messages/en.js';
import { useApp } from './context.js';
import styles from './SiteTabs.module.css';

// The three pages that are about a site rather than a report of it: its
// settings, who can reach it, and the record of who looked at whom.
//
// They are reached from the site menu, which is under the site's own name and
// not among the reports, and once somebody is on one of them this row is how
// they get to the other two without opening that menu again. It is a
// navigation of links and not a tab list: each is a page with an address of
// its own, and a tab list would promise arrow keys that go nowhere.

function Tab({ to, label }: { to: string; label: string }): JSX.Element {
  const [current] = useRoute(to);
  return (
    <Link
      to={to}
      className={[styles.tab, current ? styles.current : ''].filter(Boolean).join(' ')}
      aria-current={current ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

export function SiteTabs(): JSX.Element {
  const { site } = useApp();
  return (
    <nav className={styles.tabs} aria-label={messages.team.tabs}>
      <Tab to={`/${site.id}/settings`} label={messages.team.tabSettings} />
      <Tab to={`/${site.id}/team`} label={messages.team.tabTeam} />
      <Tab to={`/${site.id}/audit`} label={messages.team.tabAudit} />
    </nav>
  );
}

// What this person may do on the site on screen.
//
// From the scopes GET /api/me answers for each site, and not from the role in
// the site's team: a role can be held on one site alone, so somebody invited
// to a single site is in no team at all and may still be the one who runs it.
// A build of the server from before that answer carried scopes falls back to
// the team role, which was the whole truth then.
export function useSiteAccess(): { admin: boolean; teamOwner: boolean; identity: boolean } {
  const { me, site } = useApp();
  const teamOwner = me.teams.some((team) => team.id === site.teamId && team.role === 'owner');
  if (site.scopes === undefined) {
    return { admin: teamOwner, teamOwner, identity: teamOwner };
  }
  return {
    admin: site.scopes.includes('admin'),
    teamOwner,
    identity: site.scopes.includes('read:identity'),
  };
}
