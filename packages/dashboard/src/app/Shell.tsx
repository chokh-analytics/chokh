import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { Link, useLocation, useRoute } from 'wouter';

import { api } from '../lib/api.js';
import {
  readChoice,
  writeChoice,
  applyChoice,
  nextChoice,
  type ThemeChoice,
} from '../theme/theme.js';
import { useLicense, useSiteCounts } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Popover } from '../ui/Popover.js';
import { LicenseLine } from '../ui/Pro.js';
import popover from '../ui/Popover.module.css';
import { Wordmark } from '../ui/Wordmark.js';
import { AppContext, type AppContextValue } from './context.js';
import { OPEN_SHORTCUTS, Shortcuts } from './shortcuts.js';
import styles from './Shell.module.css';

// The frame every report is drawn in: the mark, the site being read, ten
// destinations, and the three controls that are about the reader rather than
// about the numbers.

interface Destination {
  path: string;
  label: string;
}

export function destinationsFor(siteId: string): Destination[] {
  return [
    { path: `/${siteId}`, label: messages.nav.overview },
    { path: `/${siteId}/realtime`, label: messages.nav.realtime },
    { path: `/${siteId}/pages`, label: messages.nav.pages },
    { path: `/${siteId}/sources`, label: messages.nav.sources },
    { path: `/${siteId}/geo`, label: messages.nav.geo },
    { path: `/${siteId}/devices`, label: messages.nav.devices },
    { path: `/${siteId}/events`, label: messages.nav.events },
    { path: `/${siteId}/goals`, label: messages.nav.goals },
    { path: `/${siteId}/funnels`, label: messages.nav.funnels },
    { path: `/${siteId}/people`, label: messages.nav.people },
  ];
}

function NavLink({ to, label }: { to: string; label: string }): JSX.Element {
  // The overview is the site root, so it would match every page under it. It is
  // the only one that has to be exact.
  const [nested] = useRoute(`${to}/*`);
  const [exact] = useRoute(to);
  const current = exact || (nested && to.split('/').length > 2);

  return (
    <Link
      to={to}
      className={[styles.navLink, current ? styles.navLinkCurrent : ''].filter(Boolean).join(' ')}
      aria-current={current ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

function ThemeToggle(): JSX.Element {
  const [choice, setChoice] = useState<ThemeChoice>(() =>
    readChoice(typeof localStorage === 'undefined' ? undefined : localStorage),
  );
  const prefersDark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const showing = choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice;

  return (
    <Button
      variant="quiet"
      label={showing === 'dark' ? messages.nav.themeLight : messages.nav.themeDark}
      onClick={() => {
        const next = nextChoice(choice, prefersDark);
        setChoice(next);
        writeChoice(typeof localStorage === 'undefined' ? undefined : localStorage, next);
        applyChoice(document.documentElement, next);
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        {showing === 'dark' ? (
          <path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4.2" />
            <path
              d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              fill="none"
            />
          </>
        )}
      </svg>
    </Button>
  );
}

// aria-haspopup is "true" and not "menu" on both triggers below. What opens is
// a group of buttons, not a menu widget: naming a menu promises arrow key
// navigation, and a screen reader tells somebody to use keys that do nothing.
function SiteSwitcher({ value }: { value: AppContextValue }): JSX.Element {
  return (
    <Popover
      align="left"
      label={messages.nav.siteSwitcher}
      trigger={({ open, toggle }) => (
        <Button variant="quiet" onClick={toggle} aria-expanded={open} aria-haspopup="true">
          {value.site.name}
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </Button>
      )}
    >
      {({ close }) => <SiteList value={value} onPicked={close} />}
    </Popover>
  );
}

// The list itself, in its own component because it mounts only when the
// switcher is open, and that is what makes one live read per site affordable:
// nothing here is asked for on a page where the list is shut, and the reads
// share their key with the Overview's own live tile.
function SiteList({
  value,
  onPicked,
}: {
  value: AppContextValue;
  onPicked: () => void;
}): JSX.Element {
  const [, navigate] = useLocation();
  const sites = useMemo(
    // By name, because the id order the API answers in is an implementation
    // detail and somebody with six sites is looking for a word. The site being
    // read stays first wherever its name falls, so the list never moves under
    // the pointer that opened it.
    () =>
      [...value.me.sites].sort((left, right) => {
        if (left.id === value.site.id) return -1;
        if (right.id === value.site.id) return 1;
        return left.name.localeCompare(right.name);
      }),
    [value.me.sites, value.site.id],
  );
  const counts = useSiteCounts(value.client, sites.map((site) => site.id));

  return (
    <>
      <p className={popover.heading}>{messages.nav.siteSwitcher}</p>
      {sites.map((site) => {
        const online = counts.online.get(site.id);
        return (
          <button
            key={site.id}
            type="button"
            className={[popover.item, site.id === value.site.id ? popover.itemCurrent : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              onPicked();
              // A site change is a navigation and not a filter: the whole tree
              // remounts rather than half of it refetching against a cache
              // that still holds the other site's numbers.
              navigate(`/${site.id}`);
            }}
          >
            <span>{site.name}</span>
            <span className={popover.itemNote}>
              {/*
                The live count is why somebody opens this list: "which of my
                sites has people on it right now" is the question, and a list
                of names cannot answer it. A count that has not arrived is
                absent rather than zero.
              */}
              {online === undefined
                ? site.domains[0]
                : format(messages.nav.siteOnline, { count: online })}
            </span>
          </button>
        );
      })}
      {sites.length === 1 && <p className={popover.heading}>{messages.nav.noOtherSites}</p>}
      <div className={popover.divider} />
      {/* The site's own settings, under the site's own name and not among the
          ten reports: it is about the site rather than a report of it. */}
      <Link to={`/${value.site.id}/settings`} className={popover.item} onClick={onPicked}>
        <span>{messages.sites.settings}</span>
      </Link>
    </>
  );
}

function AccountMenu({ value, onSignedOut }: { value: AppContextValue; onSignedOut: () => void }) {
  const [copied, setCopied] = useState(false);
  // One read for the session, and it costs nothing on a page where the menu is
  // never opened: this component is mounted with the shell, and the query is
  // cached beside the one the rest of the dashboard shares.
  const license = useLicense(value.client);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1_800);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Popover
      label={messages.nav.account}
      trigger={({ open, toggle }) => (
        <Button variant="quiet" onClick={toggle} aria-expanded={open} aria-haspopup="true">
          {value.me.user?.name ?? value.me.user?.email ?? messages.nav.account}
        </Button>
      )}
    >
      {({ close }) => (
        <>
          <p className={popover.heading}>{value.me.user?.email}</p>
          {/*
            What this install is running, said to somebody signed in and to
            nobody else. Never hidden when there is no licence: "everything you
            can see is free to self-host, for ever" is the truest line on this
            menu and the one a new self-hoster most needs to read.
          */}
          <LicenseLine license={license.data?.data ?? null} timeZone={value.site.settings.timezone} />
          <div className={popover.divider} />
          <button
            type="button"
            className={popover.item}
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href);
              setCopied(true);
              close();
            }}
          >
            <span>{copied ? messages.nav.copied : messages.nav.copyLink}</span>
          </button>
          <div className={popover.divider} />
          <button
            type="button"
            className={popover.item}
            onClick={() => {
              close();
              window.dispatchEvent(new Event(OPEN_SHORTCUTS));
            }}
          >
            <span>{messages.shortcuts.title}</span>
            <span className={popover.itemNote}>?</span>
          </button>
          <button
            type="button"
            className={popover.item}
            onClick={() => {
              close();
              void api.signOut(value.client).finally(onSignedOut);
            }}
          >
            <span>{messages.nav.signOut}</span>
          </button>
        </>
      )}
    </Popover>
  );
}

export interface ShellProps {
  value: AppContextValue;
  onSignedOut: () => void;
  children: ReactNode;
}

export function Shell({ value, onSignedOut, children }: ShellProps): JSX.Element {
  const nav = useRef<HTMLElement>(null);
  const [location] = useLocation();

  // The destinations are one row that scrolls sideways wherever ten of them do
  // not fit: in 390 pixels on a phone, and beside the mark and the account on a
  // 1024 pixel laptop. The page somebody is on has to be in view, or the row
  // says nothing about where they are: Goals, Funnels and People start past
  // the right edge. Only the row scrolls, never the page.
  useEffect(() => {
    const row = nav.current;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (row === null || row === undefined || current === null || current === undefined) {
      return;
    }
    const left = current.offsetLeft - row.offsetLeft;
    const right = left + current.offsetWidth;
    if (left < row.scrollLeft || right > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = Math.max(0, left - (row.clientWidth - current.offsetWidth) / 2);
    }
  }, [location]);

  return (
    <AppContext.Provider value={value}>
      <div className={styles.shell}>
        <a className="skip-link" href="#report">
          {messages.nav.skipToContent}
        </a>
        <header className={styles.bar}>
          <div className={styles.barInner}>
            <Link to={`/${value.site.id}`} aria-label={messages.app.wordmarkAlt}>
              <Wordmark />
            </Link>
            <SiteSwitcher value={value} />
            <nav className={styles.nav} aria-label={messages.a11y.mainLandmark} ref={nav}>
              {destinationsFor(value.site.id).map((destination) => (
                <NavLink key={destination.path} to={destination.path} label={destination.label} />
              ))}
            </nav>
            <span className={styles.spacer} />
            <div className={styles.tools}>
              <ThemeToggle />
              <AccountMenu value={value} onSignedOut={onSignedOut} />
            </div>
          </div>
        </header>
        <main className={styles.main} id="report">
          {children}
        </main>
        {/*
          Inside the provider and inside the router, because the keys act on
          the site being read and on the URL that holds the range.
        */}
        <Shortcuts />
      </div>
    </AppContext.Provider>
  );
}
