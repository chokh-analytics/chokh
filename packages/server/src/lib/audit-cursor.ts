import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { AccessScope, AuditCursor } from '../store/AnalyticsStore.js';

// The audit log's cursor as the API hands it out: one opaque string, signed.
//
// What is inside is the store's own cursor (the instant of the last row and
// the id its adapter knows it by) and the instant the listing was opened.
//
// Signed, where the people directory's cursor is not, because of what a cursor
// means here. Opening the log is recorded: a read with no cursor writes a row,
// and a later page of the same listing writes none. If a cursor were only
// encoded, anybody who may read the log could make one up that points past
// the newest row, read the whole log "from the second page" and leave no row
// saying they had. So a cursor is only ever one this server gave out, at the
// end of a page that descends from an opening that was recorded, and it is
// bound to that opening:
//
// - to the log it was for (a site's cursor is nothing at a team's log, or at
//   another site's);
// - to who opened it (handed to a colleague, it would let them read on with
//   no row of their own);
// - to what was asked (the range, the actor, the kind and the target), so an
//   opening recorded as "who looked at Ada" cannot be carried on as "who
//   looked at Grace";
// - and to an hour from the opening, so a cursor kept from last month is not
//   a way to read the older rows again for ever without a row.
//
// The key is derived from the session secret and is not the session secret,
// so nothing signed here could ever be read as a session.

// How long a listing may be paged through after it was opened.
export const AUDIT_LISTING_MS = 60 * 60 * 1000;

// What a cursor is bound to besides its place in the log.
export interface AuditListing {
  scope: AccessScope;
  // The account or the key that opened it.
  readerId: string;
  // What was asked, in one canonical line. See listingFilters.
  filters: string;
}

export interface AuditCursorCodec {
  issue(cursor: AuditCursor, openedAt: number, listing: AuditListing): string;
  // The cursor and when its listing was opened; 'expired' for one this server
  // wrote for this listing too long ago; null for anything else.
  read(
    text: string,
    listing: AuditListing,
    now: number,
  ): { after: AuditCursor; openedAt: number } | 'expired' | null;
}

const bodySchema = z.tuple([
  z.number().int().nonnegative(),
  z.string().min(1).max(128),
  z.number().int().nonnegative(),
]);

// The filters of a listing as one line. A missing filter is null, so no two
// different sets of filters ever write the same line.
export function listingFilters(filters: {
  from?: number | undefined;
  to?: number | undefined;
  actorId?: string | undefined;
  kind?: string | undefined;
  target?: string | undefined;
}): string {
  return JSON.stringify([
    filters.from ?? null,
    filters.to ?? null,
    filters.actorId ?? null,
    filters.kind ?? null,
    filters.target ?? null,
  ]);
}

export function createAuditCursorCodec(secret: string): AuditCursorCodec {
  const key = createHmac('sha256', secret).update('chokh audit cursor v1').digest();
  const sign = (body: string, listing: AuditListing): string =>
    createHmac('sha256', key)
      // JSON of an array of strings: no value can run into the next one.
      .update(JSON.stringify([listing.scope.kind, listing.scope.id, listing.readerId, listing.filters, body]))
      .digest('base64url');

  return {
    issue(cursor: AuditCursor, openedAt: number, listing: AuditListing): string {
      const body = Buffer.from(JSON.stringify([cursor.ts, cursor.id, openedAt]), 'utf8').toString(
        'base64url',
      );
      return `${body}.${sign(body, listing)}`;
    },

    read(text: string, listing: AuditListing, now: number) {
      const dot = text.lastIndexOf('.');
      if (dot <= 0) {
        return null;
      }
      const body = text.slice(0, dot);
      const given = Buffer.from(text.slice(dot + 1));
      const mine = Buffer.from(sign(body, listing));
      if (mine.length !== given.length || !timingSafeEqual(mine, given)) {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      const checked = bodySchema.safeParse(parsed);
      if (!checked.success) {
        return null;
      }
      const [ts, id, openedAt] = checked.data;
      // A listing opened in the future was not opened by this clock.
      if (openedAt > now) {
        return null;
      }
      if (now - openedAt >= AUDIT_LISTING_MS) {
        return 'expired';
      }
      return { after: { ts, id }, openedAt };
    },
  };
}
