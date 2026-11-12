import {
  foldVisitor,
  groupForFold,
  presenceEntryOf,
  routeMatchers,
  withRoute,
  type Presence,
  type PresenceEntry,
  type Site,
  type StoredEvent,
  type StoredSession,
  type StoredVisitor,
} from '@chokh/store';
import type { Pool } from 'pg';

import { NO_PARTITION, isCode, json } from './db.js';
import { inPartitionWindow, type PartitionManager } from './partitions.js';
import {
  eventRecord,
  insertEventsSql,
  sessionOf,
  sessionRecord,
  upsertSessionsSql,
  upsertVisitorsSql,
  visitorOf,
  visitorRecord,
} from './rows.js';
import { EVENTS, SESSIONS, VISITORS } from './schema.js';
import type { Sites } from './sites.js';

// Writing a batch. Two waits, whatever the batch holds: one statement reads
// what the fold needs for every visitor in it, and one statement writes
// everything the fold decided.
//
// The write is one statement, so it is one transaction: the events, the stays
// and the visitor rows land together or not at all, and a reader never finds a
// stay whose events are missing.

export interface IngestDeps {
  pool: Pool;
  sites: Sites;
  partitions: PartitionManager;
  presence: Presence;
  now(): number;
  // Told how many rows of a batch were outside the window a partition may
  // exist in, and were therefore not stored.
  onOutsideWindow(count: number): void;
}

// For every visitor of the batch, their row and their newest stay, in one
// round trip. The keys go in as two arrays and come back numbered, so one
// statement serves a batch of one visitor and a batch of a thousand. The stay
// is a walk of one entry of (site_id, visitor_id, started_at DESC).
export const INGEST_READ_SQL = `
SELECT asked.ord,
       CASE WHEN known.id IS NULL THEN NULL ELSE to_jsonb(known) END AS visitor,
       CASE WHEN latest.id IS NULL THEN NULL ELSE to_jsonb(latest) END AS open
  FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS asked(site_id, visitor_id, ord)
  LEFT JOIN ${VISITORS} known
    ON known.site_id = asked.site_id AND known.id = asked.visitor_id
  LEFT JOIN LATERAL (
         SELECT stay.*
           FROM ${SESSIONS} stay
          WHERE stay.site_id = asked.site_id AND stay.visitor_id = asked.visitor_id
          ORDER BY stay.started_at DESC
          LIMIT 1
       ) latest ON TRUE`;

interface Merge {
  site_id: string;
  visitor_id: string;
  user_id: string;
}

// Everything a batch writes, as one statement. The merge is there only when
// the fold asked for one: a visitor named for the first time, whose earlier
// events and stays take the name now, so a user lookup finds the anonymous
// history too. The stays this same statement upserts already carry the name
// and are left out of the merge, because one statement may not write one row
// twice.
export function ingestWriteSql(withMerge: boolean): string {
  const parts = [
    `stored AS (${insertEventsSql('$1')} RETURNING 1)`,
    `stays AS (${upsertSessionsSql('$2')} RETURNING 1)`,
    `people AS (${upsertVisitorsSql('$3')} RETURNING 1)`,
  ];
  if (withMerge) {
    const named = `jsonb_to_recordset($4::jsonb) AS named(site_id text, visitor_id text, user_id text)`;
    parts.push(
      `named_events AS (
       UPDATE ${EVENTS} e SET user_id = named.user_id
         FROM ${named}
        WHERE e.site_id = named.site_id AND e.visitor_id = named.visitor_id
       RETURNING 1)`,
      `named_stays AS (
       UPDATE ${SESSIONS} s SET user_id = named.user_id
         FROM ${named}
        WHERE s.site_id = named.site_id AND s.visitor_id = named.visitor_id
          AND s.id <> ALL($5::text[])
       RETURNING 1)`,
    );
  }
  return `WITH ${parts.join(',\n     ')}
SELECT (SELECT count(*) FROM stored) AS events`;
}

export function createIngest(deps: IngestDeps): (batch: StoredEvent[]) => Promise<void> {
  const { pool, sites, partitions, presence, now } = deps;

  return async function ingest(batch: StoredEvent[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    // A row whose instant no partition may exist for is not stored and does
    // not fail the rows beside it. Neither route that writes can send one (the
    // collector bounds an event to the day before it arrived), so this is what
    // stands between a caller of ingest itself and a table per month of a
    // century. It leaves before the fold, so it opens no stay either.
    const at = now();
    const kept = batch.filter((event) => inPartitionWindow(event.ts, at));
    if (kept.length < batch.length) {
      deps.onOutsideWindow(batch.length - kept.length);
    }
    if (kept.length === 0) {
      return;
    }

    const groups = [...groupForFold(kept).values()].filter((group) => group.length > 0);
    // One site read per site in the batch, for its route rules. Cached, so in
    // the steady state this is no round trip.
    const known = new Map<string, Site | null>();
    for (const group of groups) {
      const siteId = group[0]!.siteId;
      if (!known.has(siteId)) {
        known.set(siteId, await sites.site(siteId));
      }
    }

    // Read, fold, write. Two batches of one visitor arriving at the same
    // moment can both read the same open stay and the later write wins, so a
    // count can be lost, exactly as in the other adapter; a tab sends its
    // batches one after another, and the cure if that ever matters is a row
    // lock, which would cost every batch two more waits.
    const read = await pool.query<{
      ord: number;
      visitor: Record<string, unknown> | null;
      open: Record<string, unknown> | null;
    }>(INGEST_READ_SQL, [
      groups.map((group) => group[0]!.siteId),
      groups.map((group) => group[0]!.visitorId),
    ]);
    const found = new Map(read.rows.map((row) => [Number(row.ord), row]));

    const events: StoredEvent[] = [];
    const stays: StoredSession[] = [];
    const people: StoredVisitor[] = [];
    const merges: Merge[] = [];
    const live: { siteId: string; entries: PresenceEntry[] }[] = [];

    groups.forEach((group, index) => {
      const { siteId, visitorId } = group[0]!;
      const row = found.get(index + 1);
      const matchers = routeMatchers(known.get(siteId)?.settings.routeGroups ?? []);
      const folded = foldVisitor({
        siteId,
        visitorId,
        events: group.map((event) => withRoute(event, matchers)),
        open: row === undefined || row.open === null ? null : sessionOf(row.open),
        visitor: row === undefined || row.visitor === null ? null : visitorOf(row.visitor),
      });
      events.push(...folded.events);
      stays.push(...folded.sessions);
      people.push(folded.visitor);
      if (folded.merge !== undefined) {
        merges.push({ site_id: siteId, visitor_id: visitorId, user_id: folded.merge });
      }
      // Only the stays a browser was seen in. An event an application sent
      // server side moves the stay and puts nobody online.
      const entries = folded.live
        .map((session) => presenceEntryOf(session))
        .filter((entry): entry is PresenceEntry => entry !== null);
      if (entries.length > 0) {
        live.push({ siteId, entries });
      }
    });

    const params: unknown[] = [
      json(events.map(eventRecord)),
      json(stays.map(sessionRecord)),
      json(people.map(visitorRecord)),
    ];
    if (merges.length > 0) {
      params.push(json(merges), stays.map((stay) => stay.id));
    }
    const statement = ingestWriteSql(merges.length > 0);
    const instants = events.map((event) => event.ts);

    const write = async (): Promise<void> => {
      // A lookup in a set once a month has been seen; a transaction of its own
      // the first time a month is needed.
      await partitions.ensure(instants);
      try {
        await pool.query(statement, params);
      } catch (error) {
        if (!isCode(error, NO_PARTITION)) {
          throw error;
        }
        // A month this process believed in is gone: the retention purge drops
        // a month it has emptied, and another process did. Ask again, once.
        partitions.forget();
        await partitions.ensure(instants);
        await pool.query(statement, params);
      }
    };

    // The write and the presence set, neither of which needs the other's
    // answer, so they go together.
    await Promise.all([write(), ...live.map(({ siteId, entries }) => presence.touch(siteId, entries))]);
  };
}
