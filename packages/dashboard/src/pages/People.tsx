import { useState, type FormEvent, type JSX } from 'react';
import { useLocation, useParams } from 'wouter';
import type {
  RealtimeVisitor,
  TimelineEntry,
  UserProfile,
  VisitorProfile,
} from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { identityAllowed } from '../lib/api.js';
import {
  countryName,
  formatCount,
  formatDuration,
  formatExact,
  formatSince,
} from '../lib/format.js';
import { PROFILE_PRESENCE_MS, useRealtime, useUserProfile, useVisitorProfile } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { LiveDot } from '../ui/KpiTile.js';
import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { InfoDot } from '../ui/InfoDot.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
import { VisitorList } from '../ui/VisitorList.js';
import styles from './People.module.css';

// One person at a time, looked up by hand.
//
// This is the report that separates a first-party analytics product from an
// aggregate one, and it is the one that has to be built most carefully. A
// visitor id is a browser and is answerable to anybody who can read the stats;
// a user id is a person your own application named, so the server refuses that
// lookup outright without read:identity rather than answering a profile with
// the person taken out. Every lookup that names somebody writes an audit row,
// and the page says so on screen, because an audit log nobody can see is a
// promise rather than a protection.
//
// There is no directory here on purpose. A list of everybody who has ever
// visited is a different product with different obligations, and the founder's
// decision of 2026-09-19 was lookup first.

const TIMELINE_LIMIT = 50;

function when(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(ts));
}

function timeOnly(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeStyle: 'medium',
    timeZone: timezone,
  }).format(new Date(ts));
}

// Where they usually connect from: a city and a country, and no coordinates.
//
// A pair of numbers is for putting a dot on a map, and there is no map on a
// profile: printed beside somebody's name it reads as a position rather than
// as a place, which is a different claim about a person. The map on Realtime
// draws its own, from the presence set, rounded on the way in.
//
// There is no count beside it, because the contract carries one location per
// profile rather than a tally of them. A ranked list of places per person is
// AN-PPL01's, and inventing a number here would be worse than not having one.
function homeLine(profile: { homeGeo?: { country?: string; city?: string } }): string | null {
  const geo = profile.homeGeo;
  if (geo === undefined) {
    return null;
  }
  const place = [geo.city, countryName(geo.country ?? '') ?? geo.country].filter(Boolean).join(', ');
  return place === '' ? null : place;
}

function Facts({
  profile,
  timezone,
}: {
  profile: VisitorProfile | UserProfile;
  timezone: string;
}): JSX.Element {
  const home = homeLine(profile);
  const traits = profile.traits ?? {};
  const traitKeys = Object.keys(traits);

  return (
    <dl className={styles.facts}>
      <Fact label={messages.people.firstSeen} value={when(profile.firstSeenAt, timezone)} />
      <Fact label={messages.people.lastSeen} value={when(profile.lastSeenAt, timezone)} />
      <Fact
        label={messages.people.sessions}
        value={formatCount(profile.sessions)}
        title={formatExact(profile.sessions)}
      />
      <Fact
        label={messages.metrics.pageviews}
        value={formatCount(profile.pageviews)}
        title={formatExact(profile.pageviews)}
      />
      {home !== null && (
        <Fact
          label={messages.people.home}
          value={home}
          help={<InfoDot label={messages.people.home} text={messages.people.homeNote} />}
        />
      )}
      {profile.devices.length > 0 && (
        <Fact label={messages.people.sameBrowser} value={profile.devices.join(', ')} />
      )}
      {/*
        Present exactly when the server sent them, which it does only with
        read:identity. An empty row headed "Addresses" would say this person has
        none rather than that this account may not see them.
      */}
      {profile.ips.length > 0 && (
        <Fact label={messages.people.addresses} value={profile.ips.join(', ')} mono />
      )}
      {profile.firstTouch !== undefined && (
        <Fact label={messages.people.firstTouch} value={touchLine(profile.firstTouch)} />
      )}
      {profile.lastTouch !== undefined && (
        <Fact label={messages.people.lastTouch} value={touchLine(profile.lastTouch)} />
      )}
      {traitKeys.map((key) => (
        <Fact key={key} label={key} value={String(traits[key])} />
      ))}
    </dl>
  );
}

function touchLine(touch: { channel?: string; referrer?: string; utm_source?: string }): string {
  const channel =
    touch.channel === undefined
      ? undefined
      : ((messages.channels as Record<string, string>)[touch.channel] ?? touch.channel);
  return [channel, touch.referrer, touch.utm_source].filter(Boolean).join(' · ');
}

function Fact({
  label,
  value,
  title,
  mono = false,
  help,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  help?: JSX.Element;
}): JSX.Element {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>
        {label}
        {help}
      </dt>
      <dd className={[styles.factValue, mono ? styles.mono : ''].filter(Boolean).join(' ')} title={title}>
        {value}
      </dd>
    </div>
  );
}

// One row per stay, opened to show what happened in it.
//
// Fifty rows of pageviews is a log, and a log is what an analytics product
// gives you instead of an answer. A person came four times: that is the shape
// of the thing, and each of those visits opens into what they did. Every event
// carries the stay ingest stamped it with, which is what makes the grouping a
// fact rather than a guess about gaps.
interface Stay {
  id: string;
  entries: TimelineEntry[];
  from: number;
  to: number;
}

export function staysOf(entries: TimelineEntry[]): Stay[] {
  const stays: Stay[] = [];
  for (const entry of entries) {
    // A row written before ingest stamped stays has none: it becomes a stay of
    // its own rather than joining somebody else's.
    const id = entry.sessionId ?? `lone-${entry.ts}`;
    const open = stays.find((stay) => stay.id === id);
    if (open === undefined) {
      stays.push({ id, entries: [entry], from: entry.ts, to: entry.ts });
      continue;
    }
    open.entries.push(entry);
    open.from = Math.min(open.from, entry.ts);
    open.to = Math.max(open.to, entry.ts);
  }
  return stays;
}

function Timeline({
  entries,
  timezone,
}: {
  entries: TimelineEntry[];
  timezone: string;
}): JSX.Element {
  // The most recent stay is open, because that is the one somebody looking up
  // a person is almost always here for.
  const stays = staysOf(entries);
  const [open, setOpen] = useState<string[]>(() => (stays[0] === undefined ? [] : [stays[0].id]));

  if (entries.length === 0) {
    return <EmptyState message={messages.people.timelineEmpty} />;
  }

  return (
    <ol className={styles.timeline}>
      {stays.map((stay) => {
        const shown = open.includes(stay.id);
        const length = formatDuration(stay.to - stay.from) ?? '';
        return (
          <li key={stay.id} className={styles.stay}>
            <button
              type="button"
              className={styles.stayHead}
              aria-expanded={shown}
              onClick={() =>
                setOpen((was) =>
                  was.includes(stay.id)
                    ? was.filter((id) => id !== stay.id)
                    : [...was, stay.id],
                )
              }
            >
              <span className={styles.stayWhen}>{when(stay.from, timezone)}</span>
              <span className={styles.stayWhat}>
                {stay.entries.length === 1
                  ? messages.people.stayOne
                  : format(messages.people.stayOf, {
                      count: stay.entries.length,
                      duration: length,
                    })}
              </span>
              <span className={styles.stayMark} aria-hidden="true">
                {shown ? '−' : '+'}
              </span>
              <span className="sr-only">
                {shown ? messages.people.collapse : messages.people.expand}
              </span>
            </button>
            {shown && (
              <ol className={styles.entries}>
                {stay.entries.map((entry, index) => (
                  <li key={`${entry.ts}-${index}`} className={styles.entryRow}>
                    <time className={styles.time} dateTime={new Date(entry.ts).toISOString()}>
                      {timeOnly(entry.ts, timezone)}
                    </time>
                    <span className={styles.kind}>
                      {(messages.people.eventTypes as Record<string, string>)[entry.type] ??
                        entry.type}
                    </span>
                    <span className={styles.what}>{entry.name ?? entry.path ?? ''}</span>
                  </li>
                ))}
              </ol>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Profile({
  kind,
  id,
}: {
  kind: 'visitor' | 'user';
  id: string;
}): JSX.Element {
  const { client, site } = useApp();
  const [, navigate] = useLocation();
  const visitor = useVisitorProfile(client, site.id, kind === 'visitor' ? id : null);
  const user = useUserProfile(client, site.id, kind === 'user' ? id : null);
  const result = kind === 'visitor' ? visitor : user;
  const profile = result.data?.data;
  const timezone = site.settings.timezone;

  // Whether they are here right now, from the presence snapshot the rest of
  // the product already reads. A profile that cannot say "this person is on
  // /pricing at this moment" is a history book, and the reason to look
  // somebody up is usually that they are here.
  const live = useRealtime(client, site.id, PROFILE_PRESENCE_MS);
  const here = (live.data?.data.visitors ?? []).find((candidate) =>
    kind === 'visitor' ? candidate.visitorId === id : candidate.userId === id,
  );

  return (
    <div className={styles.page}>
      <h1 className="sr-only">{messages.people.title}</h1>

      <div className={styles.crumb}>
        <Button variant="quiet" onClick={() => navigate(`/${site.id}/people`)}>
          {messages.people.backToLookup}
        </Button>
      </div>

      <Card title={messages.people.profile}>
        {result.isPending ? (
          <Skeleton height={180} />
        ) : result.isError ? (
          <ErrorState error={result.error} onRetry={() => void result.refetch()} />
        ) : profile === undefined ? (
          <EmptyState message={messages.people.notFound} />
        ) : (
          <>
            <p className={styles.who}>
              <span className={styles.whoName}>
                {'userId' in profile && profile.userId !== undefined
                  ? profile.userId
                  : messages.identity.anonymous}
              </span>
              <span className={styles.whoId}>
                {kind === 'visitor' ? (profile as VisitorProfile).visitorId : id}
              </span>
              <Presence here={here} lastSeenAt={profile.lastSeenAt} timezone={timezone} />
            </p>
            <Facts profile={profile} timezone={timezone} />
            <p className={styles.logged}>{messages.people.logged}</p>
          </>
        )}
      </Card>

      <Card
        title={messages.people.timeline}
        help={
          <InfoDot
            label={messages.people.timeline}
            text={format(messages.people.timelineNote, { count: TIMELINE_LIMIT })}
          />
        }
      >
        {result.isPending ? (
          <Skeleton height={240} />
        ) : profile === undefined ? (
          <EmptyState message={messages.people.timelineEmpty} />
        ) : (
          <Timeline entries={profile.timeline} timezone={timezone} />
        )}
      </Card>
    </div>
  );
}

// Here now, or last seen. One line, and never both.
function Presence({
  here,
  lastSeenAt,
  timezone,
}: {
  here: RealtimeVisitor | undefined;
  lastSeenAt: number;
  timezone: string;
}): JSX.Element {
  if (here === undefined) {
    return (
      <span className={styles.away}>
        {format(messages.people.lastSeenAgo, {
          when: formatSince(lastSeenAt, Date.now(), timezone),
        })}
      </span>
    );
  }
  return (
    <span className={styles.here}>
      <LiveDot on />
      {messages.people.online}
      {here.path === undefined
        ? ''
        : ` · ${format(messages.people.onPage, { path: here.path })}`}
    </span>
  );
}

function Lookup(): JSX.Element {
  const { site } = useApp();
  const [, navigate] = useLocation();
  const [visitorId, setVisitorId] = useState('');
  const [userId, setUserId] = useState('');

  const go = (event: FormEvent, path: string, value: string): void => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') {
      return;
    }
    navigate(`/${site.id}/people/${path}/${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className={styles.page}>
      <h1 className="sr-only">{messages.people.title}</h1>
      <Card title={messages.people.title}>
        <div className={styles.lookup}>
          <p className={styles.lede}>{messages.people.lede}</p>

          <form className={styles.form} onSubmit={(event) => go(event, 'u', userId)}>
            <Field
              label={messages.people.lookupUser}
              help={messages.people.lookupUserHelp}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              autoComplete="off"
            />
            <Button type="submit" variant="primary">
              {messages.people.find}
            </Button>
          </form>

          <form className={styles.form} onSubmit={(event) => go(event, 'v', visitorId)}>
            <Field
              label={messages.people.lookupVisitor}
              help={messages.people.lookupVisitorHelp}
              value={visitorId}
              onChange={(event) => setVisitorId(event.target.value)}
              autoComplete="off"
            />
            <Button type="submit">{messages.people.find}</Button>
          </form>

          {/*
            Said before anybody tries it, not after the server refuses. A person
            who does not have read:identity should learn that from this sentence
            rather than from a 403 with somebody's id already typed into it.
          */}
          <p className={styles.note}>{messages.people.needsScope}</p>
        </div>
      </Card>

      <HereNow />
    </div>
  );
}

// Everybody the site has seen in the last half hour, under the search box.
//
// A lookup with nothing beside it is a page that only works for somebody who
// already has an id to paste, and nobody has one: the founder's third decision
// on this ticket was that v1 is lookup plus this list, and a directory of
// everybody who ever visited is a different product. It is the same read the
// Realtime page makes, so opening this costs nothing extra, and a row is a way
// into the profile rather than a report of its own.
function HereNow(): JSX.Element {
  const { client, site } = useApp();
  const [, navigate] = useLocation();
  const live = useRealtime(client, site.id, PROFILE_PRESENCE_MS);
  const snapshot = live.data?.data;
  const identity = identityAllowed(live.data?.meta);
  const nobody =
    snapshot !== undefined && snapshot.visitors.length === 0 && snapshot.recent.length === 0;

  return (
    <Card
      title={messages.people.hereNow}
      help={<InfoDot label={messages.people.hereNow} text={messages.people.hereNowNote} />}
    >
      {live.isPending ? (
        <Skeleton height={160} />
      ) : live.isError ? (
        <ErrorState error={live.error} onRetry={() => void live.refetch()} />
      ) : nobody || snapshot === undefined ? (
        <EmptyState message={messages.people.nobodyHereNow} />
      ) : (
        <VisitorList
          online={snapshot.visitors}
          recent={snapshot.recent}
          identity={identity}
          timezone={site.settings.timezone}
          onSelect={(visitor) =>
            navigate(`/${site.id}/people/v/${encodeURIComponent(visitor.visitorId)}`)
          }
        />
      )}
    </Card>
  );
}

export function People(): JSX.Element {
  const params = useParams();
  const kind = params.kind === 'u' ? 'user' : 'visitor';
  const id = params.id ?? '';

  if (id === '') {
    return <Lookup />;
  }
  return <Profile kind={kind} id={decodeURIComponent(id)} />;
}
