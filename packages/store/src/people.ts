import type { PeopleCursor, PeopleQuery, PersonRow } from './query.js';
import type { StoredVisitor } from './types.js';

// The people directory's rules, shared so the MongoDB answer and the in-memory
// answer list the same people in the same order.
//
// The order is the most recent sign of life first and, between two people seen
// in the same millisecond, the larger visitor id first. That second key is what
// makes the order total: a cursor of (lastSeenAt, visitorId) then names one
// exact place in it, and the next page starts strictly after that place.

// A visitor row as one line of the directory.
export function personFrom(visitor: StoredVisitor): PersonRow {
  const row: PersonRow = {
    visitorId: visitor.id,
    firstSeenAt: visitor.firstSeenAt,
    lastSeenAt: visitor.lastSeenAt,
    sessions: visitor.sessions,
    pageviews: visitor.pageviews,
    devices: [...visitor.devices],
    ips: [...visitor.ips],
  };
  if (visitor.userId !== undefined) row.userId = visitor.userId;
  if (visitor.traits !== undefined) row.traits = { ...visitor.traits };
  if (visitor.homeGeo !== undefined) row.homeGeo = visitor.homeGeo;
  return row;
}

// Negative when left comes first in the directory.
export function comparePeople(left: PersonRow, right: PersonRow): number {
  if (left.lastSeenAt !== right.lastSeenAt) {
    return right.lastSeenAt - left.lastSeenAt;
  }
  if (left.visitorId === right.visitorId) {
    return 0;
  }
  return left.visitorId < right.visitorId ? 1 : -1;
}

// Whether a row comes strictly after the cursor.
export function isAfter(row: PersonRow, cursor: PeopleCursor): boolean {
  return (
    row.lastSeenAt < cursor.lastSeenAt ||
    (row.lastSeenAt === cursor.lastSeenAt && row.visitorId < cursor.visitorId)
  );
}

// Whether a row answers the query's filters. The cursor is separate, because an
// adapter answers that one with an index bound rather than a test per row.
export function matchesPeople(
  row: PersonRow,
  query: Pick<PeopleQuery, 'identifiedOnly' | 'q'>,
): boolean {
  if (query.identifiedOnly === true && row.userId === undefined) {
    return false;
  }
  if (query.q === undefined || query.q === '') {
    return true;
  }
  const needle = query.q.toLowerCase();
  const haystack = [row.visitorId, row.userId ?? '', ...Object.values(row.traits ?? {})];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

// The cursor of the last row, when there may be more after it.
export function cursorOf(row: PersonRow): PeopleCursor {
  return { lastSeenAt: row.lastSeenAt, visitorId: row.visitorId };
}
