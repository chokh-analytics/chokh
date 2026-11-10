import { useEffect, useRef, useState, type JSX } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import type { PersonRow } from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { useWallClock } from '../app/useNow.js';
import { identityAllowed } from '../lib/api.js';
import { countryName, formatCount, formatExact, formatSince } from '../lib/format.js';
import { PROFILE_PRESENCE_MS, usePeople, useRealtime } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { InfoDot } from '../ui/InfoDot.js';
import { LiveDot } from '../ui/KpiTile.js';
import { EmptyState, ErrorState, Skeleton, Working } from '../ui/State.js';
import styles from './PeopleDirectory.module.css';

// Everybody the site has seen, a page at a time (AN-PPL02).
//
// The list is the visitor rows, newest sign of life first, and a row opens the
// profile the rest of People already draws. It is readable by anybody who may
// read the numbers, with names and addresses withheld from an account without
// read:identity the same way a profile withholds them; the search is not, because
// a search box that finds "Ada" is a way to name a person, so the box says so and
// stays shut rather than letting somebody type a name into a 403.
//
// The search and the switch live in the address bar like every other choice in
// this dashboard, so a filtered list survives a trip to a profile and back and
// can be sent to somebody.

const SEARCH_PARAM = 'q';
const NAMED_PARAM = 'named';
// Long enough that a name typed at speed is one request, short enough that the
// list still feels like it answers the keyboard.
const SEARCH_DEBOUNCE_MS = 300;

function placeOf(row: PersonRow): string {
  const geo = row.homeGeo;
  if (geo === undefined) {
    return '';
  }
  return [geo.city, countryName(geo.country ?? '') ?? geo.country].filter(Boolean).join(', ');
}

// Who a row is, in the words the person reading it would use: the name the
// application gave, then its id for them, and only then a browser.
function nameOf(row: PersonRow, identity: boolean): { name: string; id: string } {
  if (!identity) {
    // Without read:identity nobody on the page is named, so nobody is called
    // anonymous either: that would be a statement about somebody who may well
    // be signed in.
    return { name: messages.identity.anonymous, id: row.visitorId.slice(0, 10) };
  }
  const given = row.traits?.name ?? row.traits?.email;
  if (given !== undefined && given !== '') {
    return { name: given, id: row.userId ?? row.visitorId.slice(0, 10) };
  }
  if (row.userId !== undefined) {
    return { name: row.userId, id: row.visitorId.slice(0, 10) };
  }
  return { name: messages.identity.anonymous, id: row.visitorId.slice(0, 10) };
}

function useFilters(): {
  q: string;
  named: boolean;
  set: (next: { q?: string; named?: boolean }) => void;
} {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const q = (params.get(SEARCH_PARAM) ?? '').trim();
  const named = params.get(NAMED_PARAM) === '1';

  const set = (next: { q?: string; named?: boolean }): void => {
    const nextParams = new URLSearchParams(search);
    if (next.q !== undefined) {
      if (next.q === '') nextParams.delete(SEARCH_PARAM);
      else nextParams.set(SEARCH_PARAM, next.q);
    }
    if (next.named !== undefined) {
      if (next.named) nextParams.set(NAMED_PARAM, '1');
      else nextParams.delete(NAMED_PARAM);
    }
    const text = nextParams.toString();
    // Replaced rather than pushed: every keystroke a history entry would make
    // the back button walk through a name one letter at a time.
    navigate(`${location}${text === '' ? '' : `?${text}`}`, { replace: true });
  };
  return { q, named, set };
}

export function PeopleDirectory(): JSX.Element {
  const { client, site } = useApp();
  const filters = useFilters();
  const list = usePeople(client, site.id, { identifiedOnly: filters.named, q: filters.q });
  const live = useRealtime(client, site.id, PROFILE_PRESENCE_MS);
  const now = useWallClock();
  const timezone = site.settings.timezone;

  // What is in the box, which runs ahead of the address bar by the debounce.
  const [text, setText] = useState(filters.q);
  const pushed = useRef(filters.q);
  useEffect(() => {
    // The address bar moved on its own (back, a pasted link): the box follows.
    if (filters.q !== pushed.current) {
      pushed.current = filters.q;
      setText(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    const wanted = text.trim();
    if (wanted === pushed.current) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      pushed.current = wanted;
      filters.set({ q: wanted });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // Only the box restarts the wait: the clock and the live poll re-render
    // this page every few seconds, and they must not hold a search back.
  }, [text]);

  const pages = list.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.data.people);
  // Known from the first answer, and assumed until then: a box that starts
  // shut and opens a moment later is worse than one that shuts on the answer.
  const identity = pages[0] === undefined ? true : identityAllowed(pages[0].meta);
  const online = new Set((live.data?.data.visitors ?? []).map((visitor) => visitor.visitorId));

  const empty =
    filters.q !== ''
      ? format(messages.people.nobodyMatches, { q: filters.q })
      : filters.named
        ? messages.people.nobodyIdentified
        : messages.people.nobodyYet;

  return (
    <Card
      title={messages.people.directory}
      help={<InfoDot label={messages.people.directory} text={messages.people.directoryNote} />}
    >
      <div className={styles.toolbar}>
        <form
          className={styles.search}
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            pushed.current = text.trim();
            filters.set({ q: text.trim() });
          }}
        >
          <Field
            label={messages.people.search}
            type="search"
            placeholder={messages.people.searchPlaceholder}
            help={identity ? messages.people.searchHelp : messages.people.searchNeedsScope}
            value={identity ? text : ''}
            disabled={!identity}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </form>
        <label className={styles.switch}>
          <input
            type="checkbox"
            role="switch"
            className={styles.switchInput}
            checked={filters.named}
            onChange={(event) => filters.set({ named: event.target.checked })}
          />
          <span className={styles.switchTrack} aria-hidden="true">
            <span className={styles.switchThumb} />
          </span>
          <span className={styles.switchLabel}>{messages.people.identifiedOnly}</span>
        </label>
      </div>

      {list.isFetching && !list.isFetchingNextPage && !list.isPending && <Working />}

      {list.isPending ? (
        <div className={styles.loading}>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          message={empty}
          action={
            filters.q === ''
              ? undefined
              : {
                  label: messages.people.clearSearch,
                  onClick: () => {
                    pushed.current = '';
                    setText('');
                    filters.set({ q: '' });
                  },
                }
          }
        />
      ) : (
        <>
          {/*
            The table scrolls inside its card and never takes the page with it,
            and the box can take focus so a keyboard can scroll it too.
          */}
          <div
            className={styles.scroll}
            tabIndex={0}
            role="group"
            aria-label={messages.people.directoryCaption}
          >
            <table className={styles.table}>
              <caption className="sr-only">{messages.people.directoryCaption}</caption>
              <thead className={styles.head}>
                <tr>
                  <th scope="col">{messages.people.person}</th>
                  <th scope="col">{messages.people.lastSeenColumn}</th>
                  <th scope="col" className={styles.right}>
                    {messages.people.visits}
                  </th>
                  <th scope="col" className={styles.right}>
                    {messages.metrics.pageviews}
                  </th>
                  <th scope="col">{messages.people.place}</th>
                  <th scope="col">{messages.people.device}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const who = nameOf(row, identity);
                  const here = online.has(row.visitorId);
                  return (
                    <tr key={row.visitorId} className={styles.row}>
                      <td className={styles.cell}>
                        <Link
                          href={`/${site.id}/people/v/${encodeURIComponent(row.visitorId)}`}
                          className={styles.link}
                        >
                          <LiveDot on={here} />
                          <span className={styles.who}>
                            <span className={styles.whoName}>{who.name}</span>
                            <span className={styles.whoId}>{who.id}</span>
                          </span>
                          {here && <span className="sr-only">{messages.people.onlineNow}</span>}
                        </Link>
                      </td>
                      <td className={styles.cell} title={new Date(row.lastSeenAt).toISOString()}>
                        {formatSince(row.lastSeenAt, now, timezone)}
                      </td>
                      <td className={[styles.cell, styles.num].join(' ')} title={formatExact(row.sessions)}>
                        {formatCount(row.sessions)}
                      </td>
                      <td
                        className={[styles.cell, styles.num].join(' ')}
                        title={formatExact(row.pageviews)}
                      >
                        {formatCount(row.pageviews)}
                      </td>
                      <td className={styles.cell}>{placeOf(row)}</td>
                      <td className={styles.cell}>{row.devices[0] ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={styles.foot}>
            <p className={styles.count} aria-live="polite">
              {format(list.hasNextPage ? messages.people.showing : messages.people.showingAll, {
                count: formatCount(rows.length),
              })}
            </p>
            {list.hasNextPage && (
              <Button
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
                aria-busy={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? messages.people.loadingMore : messages.people.more}
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
