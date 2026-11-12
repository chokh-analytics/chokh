import {
  PROFILE_EVENT_LIMIT,
  REALTIME_WINDOW_MS,
  cursorOf,
  personFrom,
  profileFrom,
  snapshotFrom,
  type AnalyticsStore,
  type PeoplePage,
  type PeopleQuery,
  type Presence,
  type RealtimeSnapshot,
  type UserProfile,
  type VisitorProfile,
} from '@chokh/store';
import type { Pool } from 'pg';

import { Params, type Statement } from './reads.sql.js';
import { EVENT_COLUMNS, VISITOR_COLUMNS, eventOf, visitorOf } from './rows.js';
import { EVENTS, VISITORS } from './schema.js';
import type { Sites } from './sites.js';

// The reads about people rather than counts: who is here now, one person's
// profile, and the directory of everybody.

export type People = Pick<
  AnalyticsStore,
  'realtime' | 'visitor' | 'user' | 'visitorIdForUser' | 'people'
>;

export interface PeopleDeps {
  pool: Pool;
  sites: Sites;
  presence: Presence;
  now(): number;
}

// Whose rows a profile is made of: one visitor's, or everybody an identify has
// given one name.
type Who = { visitorId: string } | { userId: string };

function whoColumn(who: Who): { events: string; visitors: string; value: string } {
  return 'visitorId' in who
    ? { events: 'visitor_id', visitors: 'id', value: who.visitorId }
    : { events: 'user_id', visitors: 'user_id', value: who.userId };
}

// The three reads of a profile. Each is a walk of one index: the visitor row
// by its key (or the rows a name has, by the partial user index), and the
// person's events by (site_id, visitor_id, ts) or the partial
// (site_id, user_id, ts).
export function profileVisitorsSql(siteId: string, who: Who): Statement {
  const by = whoColumn(who);
  return {
    text: `SELECT ${VISITOR_COLUMNS} FROM ${VISITORS} v WHERE v.site_id = $1 AND v.${by.visitors} = $2`,
    values: [siteId, by.value],
  };
}

// The custom event count is the one number the visitor row does not carry,
// and it is taken without loading a history.
export function profileSummarySql(siteId: string, who: Who): Statement {
  const by = whoColumn(who);
  return {
    text: `
SELECT count(*) AS seen, min(e.ts) AS "firstSeenAt", max(e.ts) AS "lastSeenAt",
       count(*) FILTER (WHERE e.type = 'pageview') AS pageviews,
       count(*) FILTER (WHERE e.type = 'event') AS events,
       coalesce(array_agg(DISTINCT e.visitor_id), '{}') AS "visitorIds"
  FROM ${EVENTS} e
 WHERE e.site_id = $1 AND e.${by.events} = $2`,
    values: [siteId, by.value],
  };
}

// The newest events, newest first. Two of one millisecond come back in the
// order they were written, which the sequence holds.
export function profileEventsSql(siteId: string, who: Who): Statement {
  const by = whoColumn(who);
  return {
    text: `
SELECT ${EVENT_COLUMNS}
  FROM ${EVENTS} e
 WHERE e.site_id = $1 AND e.${by.events} = $2
 ORDER BY e.ts DESC, e.seq DESC
 LIMIT ${PROFILE_EVENT_LIMIT}`,
    values: [siteId, by.value],
  };
}

// The people directory's read: one walk of (site_id, last_seen_at DESC, id
// DESC) in its own order, with no sort, stopping at the page.
//
// The cursor is a bound on that walk: the rows strictly after (lastSeenAt,
// id), written as one row comparison so the index answers it. identifiedOnly
// and q are tests on the rows the walk fetches. The walk asks for one row more
// than the page, which is how the adapter knows whether there is a next one.
//
// q is the same case-insensitive piece of text people.ts matches: of the
// visitor id, the userId or any trait value. It is lowercased here and looked
// for in the terms ingest lowercased on the way in, with strpos, so a search
// box is text and never a pattern.
export function peopleSql(query: PeopleQuery): Statement {
  const params = new Params();
  const parts = [`v.site_id = ${params.add(query.siteId)}`];
  if (query.after !== undefined) {
    parts.push(
      `(v.last_seen_at, v.id) < (${params.add(query.after.lastSeenAt)}::bigint, ${params.add(query.after.visitorId)})`,
    );
  }
  if (query.identifiedOnly === true) {
    parts.push('v.user_id IS NOT NULL');
  }
  if (query.q !== undefined && query.q !== '') {
    parts.push(
      `EXISTS (SELECT 1 FROM unnest(v.search) AS term WHERE strpos(term, ${params.add(query.q.toLowerCase())}) > 0)`,
    );
  }
  return {
    text: `
SELECT ${VISITOR_COLUMNS}
  FROM ${VISITORS} v
 WHERE ${parts.join(' AND ')}
 ORDER BY v.last_seen_at DESC, v.id DESC
 LIMIT ${params.add(query.limit + 1)}`,
    values: params.values,
  };
}

export function createPeople(deps: PeopleDeps): People {
  const { pool, sites, presence, now } = deps;

  async function profile(
    siteId: string,
    who: Who,
  ): Promise<{ body: ReturnType<typeof profileFrom>; visitorIds: string[] } | null> {
    const ask = <Row extends Record<string, unknown>>(statement: Statement): Promise<Row[]> =>
      pool.query<Row>(statement.text, statement.values).then((result) => result.rows);
    // Three reads that need nothing from one another: one wait.
    const [visitorRows, [summary], recent] = await Promise.all([
      ask(profileVisitorsSql(siteId, who)),
      ask<{
        seen: number;
        firstSeenAt: number | null;
        lastSeenAt: number | null;
        pageviews: number;
        events: number;
        visitorIds: string[];
      }>(profileSummarySql(siteId, who)),
      ask(profileEventsSql(siteId, who)),
    ]);
    const visitors = visitorRows.map(visitorOf);
    const seen = summary !== undefined && summary.seen > 0;
    if (!seen && visitors.length === 0) {
      return null;
    }
    const ordered = recent.map(eventOf).reverse();
    const fromEvents = seen ? summary.visitorIds : [];
    const visitorIds = [...new Set([...visitors.map((row) => row.id), ...fromEvents])].sort();
    const exact = seen
      ? {
          firstSeenAt: Number(summary.firstSeenAt),
          lastSeenAt: Number(summary.lastSeenAt),
          pageviews: summary.pageviews,
          events: summary.events,
        }
      : undefined;
    return { body: profileFrom(ordered, visitors, exact), visitorIds };
  }

  return {
    async realtime(siteId: string, sinceMs = REALTIME_WINDOW_MS): Promise<RealtimeSnapshot> {
      await sites.siteOrThrow(siteId);
      const at = now();
      // Presence is not storage: it is whichever backend the host handed in,
      // and this adapter holds none of it. As far back as the caller asked,
      // which defaults to the whole presence window.
      return snapshotFrom(await presence.entries(siteId, at - sinceMs), at);
    },

    async visitor(siteId: string, visitorId: string): Promise<VisitorProfile | null> {
      const found = await profile(siteId, { visitorId });
      return found === null ? null : { siteId, visitorId, ...found.body };
    },

    async user(siteId: string, userId: string): Promise<UserProfile | null> {
      const found = await profile(siteId, { userId });
      return found === null ? null : { siteId, visitorIds: found.visitorIds, ...found.body, userId };
    },

    async visitorIdForUser(siteId: string, userId: string): Promise<string | null> {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM ${VISITORS}
          WHERE site_id = $1 AND user_id = $2
          ORDER BY last_seen_at DESC, id DESC
          LIMIT 1`,
        [siteId, userId],
      );
      return result.rows[0]?.id ?? null;
    },

    async people(query: PeopleQuery): Promise<PeoplePage> {
      const statement = peopleSql(query);
      const result = await pool.query(statement.text, statement.values);
      const rows = result.rows.map(visitorOf);
      const people = rows.slice(0, query.limit).map(personFrom);
      const last = people[people.length - 1];
      return {
        people,
        next: rows.length > query.limit && last !== undefined ? cursorOf(last) : null,
      };
    },
  };
}
