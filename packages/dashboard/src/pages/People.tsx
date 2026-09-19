import { useState, type FormEvent, type JSX } from 'react';
import { useLocation, useParams } from 'wouter';
import { roundCoordinate } from '@chokh/store/contract';
import type { TimelineEntry, UserProfile, VisitorProfile } from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { countryName, formatCount, formatExact } from '../lib/format.js';
import { useUserProfile, useVisitorProfile } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { InfoDot } from '../ui/InfoDot.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
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

// Where they usually connect from, to two decimals.
//
// The presence set rounds its coordinates on the way in, so the Realtime map is
// publishable by construction. A visitor row does not: ingest keeps what the
// geo database gave it. Rounding here, with the store's own function rather
// than a second copy of the arithmetic, is what makes this line a place rather
// than an address.
function homeLine(profile: { homeGeo?: { country?: string; city?: string; lat?: number; lon?: number } }): string | null {
  const geo = profile.homeGeo;
  if (geo === undefined) {
    return null;
  }
  const place = [geo.city, countryName(geo.country ?? '') ?? geo.country].filter(Boolean).join(', ');
  if (geo.lat === undefined || geo.lon === undefined) {
    return place === '' ? null : place;
  }
  const coordinates = `${roundCoordinate(geo.lat).toFixed(2)}, ${roundCoordinate(geo.lon).toFixed(2)}`;
  return place === '' ? coordinates : `${place} (${coordinates})`;
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

function Timeline({
  entries,
  timezone,
}: {
  entries: TimelineEntry[];
  timezone: string;
}): JSX.Element {
  if (entries.length === 0) {
    return <EmptyState message={messages.people.timelineEmpty} />;
  }
  let lastDay = '';
  return (
    <ol className={styles.timeline}>
      {entries.map((entry, index) => {
        const day = when(entry.ts, timezone).split(',')[0] ?? '';
        const newDay = day !== lastDay;
        lastDay = day;
        return (
          <li key={`${entry.ts}-${index}`} className={styles.entry}>
            {/*
              The date once per day rather than on every row. Fifty rows that
              each repeat "18 Sep 2026" are fifty rows of noise around the one
              column somebody is reading.
            */}
            {newDay && <p className={styles.day}>{day}</p>}
            <div className={styles.entryRow}>
              <time className={styles.time} dateTime={new Date(entry.ts).toISOString()}>
                {timeOnly(entry.ts, timezone)}
              </time>
              <span className={styles.kind}>
                {(messages.people.eventTypes as Record<string, string>)[entry.type] ?? entry.type}
              </span>
              <span className={styles.what}>{entry.name ?? entry.path ?? ''}</span>
            </div>
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
    </div>
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
