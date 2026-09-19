import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Link, useLocation, useRoute } from 'wouter';

import { api } from '../lib/api.js';
import {
  readChoice,
  writeChoice,
  applyChoice,
  nextChoice,
  type ThemeChoice,
} from '../theme/theme.js';
import { messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Popover } from '../ui/Popover.js';
import popover from '../ui/Popover.module.css';
import { Wordmark } from '../ui/Wordmark.js';
import { AppContext, type AppContextValue } from './context.js';
import styles from './Shell.module.css';

// The frame every report is drawn in: the mark, the site being read, seven
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

function SiteSwitcher({ value }: { value: AppContextValue }): JSX.Element {
  const [, navigate] = useLocation();
  const others = value.me.sites;

  return (
    <Popover
      align="left"
      label={messages.nav.siteSwitcher}
      trigger={({ open, toggle }) => (
        <Button variant="quiet" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
          {value.site.name}
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </Button>
      )}
    >
      {({ close }) => (
        <>
          <p className={popover.heading}>{messages.nav.siteSwitcher}</p>
          {others.map((site) => (
            <button
              key={site.id}
              type="button"
              className={[popover.item, site.id === value.site.id ? popover.itemCurrent : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                close();
                // A site change is a navigation and not a filter: the whole
                // tree remounts rather than half of it refetching against a
                // cache that still holds the other site's numbers.
                navigate(`/${site.id}`);
              }}
            >
              <span>{site.name}</span>
              <span className={popover.itemNote}>{site.domains[0]}</span>
            </button>
          ))}
          {others.length === 1 && <p className={popover.heading}>{messages.nav.noOtherSites}</p>}
        </>
      )}
    </Popover>
  );
}

function AccountMenu({ value, onSignedOut }: { value: AppContextValue; onSignedOut: () => void }) {
  const [copied, setCopied] = useState(false);

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
        <Button variant="quiet" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
          {value.me.user?.name ?? value.me.user?.email ?? messages.nav.account}
        </Button>
      )}
    >
      {({ close }) => (
        <>
          <p className={popover.heading}>{value.me.user?.email}</p>
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
            <nav className={styles.nav} aria-label={messages.a11y.mainLandmark}>
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
      </div>
    </AppContext.Provider>
  );
}
