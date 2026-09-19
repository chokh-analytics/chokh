import type { JSX } from 'react';
import type { RealtimeVisitor } from '@chokh/store/contract';

import { useWallClock } from '../app/useNow.js';
import { countryName, formatOnlineFor, formatSince } from '../lib/format.js';
import { format, messages } from '../messages/en.js';
import { LiveDot } from './KpiTile.js';
import styles from './VisitorList.module.css';

// Who is here, and who was here a few minutes ago.
//
// The two lists are one table with a muted half, which is the founder's
// decision of 2026-09-19 and the reason is a quiet hour: a page that empties at
// three in the morning reads as broken, and "seen in the last thirty minutes"
// is the difference between a quiet site and a stopped one. Nothing in the
// second half is counted anywhere: the three numbers above are the online list
// and only ever the online list.
//
// The address column exists exactly when the payload carries an address, which
// the server states in its meta rather than leaving a page to infer from a
// missing field: an absent address and a withheld one look identical and mean
// different things.

export interface VisitorListProps {
  online: RealtimeVisitor[];
  recent: RealtimeVisitor[];
  identity: boolean;
  // Which clock a time is written in. The site's, like every other time in
  // this product.
  timezone: string;
  // The wall clock, for tests. The component reads its own otherwise, because
  // the shell's clock is rounded up to the next minute so a range never ends
  // in the past, and a stay measured against it reads up to fifty nine seconds
  // long.
  now?: number;
  // What a row does. A visitor id is a path into People.
  onSelect?: (visitor: RealtimeVisitor) => void;
}

function deviceOf(visitor: RealtimeVisitor): string {
  return [visitor.browser, visitor.os].filter(Boolean).join(', ');
}

function placeOf(visitor: RealtimeVisitor): string {
  const country = countryName(visitor.country) ?? visitor.country;
  return [visitor.city, country].filter(Boolean).join(', ');
}

function Row({
  visitor,
  identity,
  now,
  timezone,
  muted,
  onSelect,
}: {
  visitor: RealtimeVisitor;
  identity: boolean;
  now: number;
  timezone: string;
  muted: boolean;
  onSelect?: (visitor: RealtimeVisitor) => void;
}): JSX.Element {
  // "Visitor" and not "Anonymous". Without read:identity the payload carries no
  // userId, so a signed-in person and an anonymous one are indistinguishable
  // here: calling them anonymous is a statement about somebody who may well be
  // signed in.
  const who = identity ? (visitor.userId ?? messages.identity.anonymous) : messages.identity.anonymous;

  const name = (
    <span className={styles.who}>
      <LiveDot on={!muted} />
      <span className={styles.whoName}>{who}</span>
      <span className={styles.whoId}>{visitor.visitorId.slice(0, 10)}</span>
    </span>
  );

  return (
    <tr className={muted ? styles.rowMuted : undefined}>
      <td className={styles.cell}>
        {onSelect === undefined ? (
          name
        ) : (
          <button type="button" className={styles.link} onClick={() => onSelect(visitor)}>
            {name}
          </button>
        )}
      </td>
      <td className={styles.cell}>
        <span className={styles.path}>{visitor.path ?? messages.states.unknown}</span>
      </td>
      <td className={styles.cell}>{placeOf(visitor)}</td>
      <td className={styles.cell}>{deviceOf(visitor)}</td>
      {identity && <td className={[styles.cell, styles.mono].join(' ')}>{visitor.ip ?? ''}</td>}
      <td className={[styles.cell, styles.mono, styles.right].join(' ')}>
        {/*
          A stay length for somebody who is here, and when they were last seen
          for somebody who is not. "Online for 4m" under a heading that says
          the same thing is a number about a visit that ended.
        */}
        {muted
          ? format(messages.realtime.seenAgo, {
              when: formatSince(visitor.lastSeenAt, now, timezone),
            })
          : formatOnlineFor(visitor.since, now)}
      </td>
    </tr>
  );
}

export function VisitorList({
  online,
  recent,
  identity,
  timezone,
  now,
  onSelect,
}: VisitorListProps): JSX.Element {
  const ticking = useWallClock();
  const at = now ?? ticking;

  return (
    <table className={styles.table}>
      <caption className="sr-only">{messages.realtime.listCaption}</caption>
      <thead className={styles.head}>
        <tr>
          <th scope="col">{messages.realtime.visitor}</th>
          <th scope="col">{messages.dimensions.page}</th>
          <th scope="col">{messages.realtime.place}</th>
          <th scope="col">{messages.dimensions.device}</th>
          {identity && <th scope="col">{messages.realtime.address}</th>}
          <th scope="col" className={styles.right}>
            {messages.realtime.onlineFor}
          </th>
        </tr>
      </thead>
      <tbody>
        {online.map((visitor) => (
          <Row
            key={visitor.visitorId}
            visitor={visitor}
            identity={identity}
            now={at}
            timezone={timezone}
            muted={false}
            onSelect={onSelect}
          />
        ))}
        {recent.length > 0 && (
          <tr>
            <th
              scope="colgroup"
              colSpan={identity ? 6 : 5}
              className={styles.divider}
            >
              {messages.realtime.recentHeading}
            </th>
          </tr>
        )}
        {recent.map((visitor) => (
          <Row
            key={visitor.visitorId}
            visitor={visitor}
            identity={identity}
            now={at}
            timezone={timezone}
            muted
            onSelect={onSelect}
          />
        ))}
      </tbody>
    </table>
  );
}
