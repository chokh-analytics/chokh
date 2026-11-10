import { z } from 'zod';

import type { PeopleCursor } from '../store/AnalyticsStore.js';

// The people directory's cursor as the API hands it out: one opaque string.
//
// Opaque so a client keeps it rather than builds it: what is inside is the last
// row's sighting and visitor id, and a client that started composing those
// would be tied to an order the server is free to change. base64url, so it
// travels in a query string without escaping. It is not signed, and does not
// need to be: a forged cursor can only start a page somewhere else in a list the
// caller may already read.

const cursorSchema = z.tuple([z.number().int().nonnegative(), z.string().min(1).max(256)]);

export function encodePeopleCursor(cursor: PeopleCursor): string {
  return Buffer.from(JSON.stringify([cursor.lastSeenAt, cursor.visitorId]), 'utf8').toString(
    'base64url',
  );
}

// Null for anything that is not a cursor this server wrote.
export function decodePeopleCursor(text: string): PeopleCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const checked = cursorSchema.safeParse(parsed);
  if (!checked.success) {
    return null;
  }
  const [lastSeenAt, visitorId] = checked.data;
  return { lastSeenAt, visitorId };
}
