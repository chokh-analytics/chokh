import { describe, expect, it } from 'vitest';

import {
  AUDIT_LISTING_MS,
  createAuditCursorCodec,
  listingFilters,
  type AuditListing,
} from './audit-cursor.js';
import { createSessionCodec } from '../services/auth.service.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const SECRET = 'a-test-secret-that-is-not-a-real-one';

const listing: AuditListing = {
  scope: { kind: 'site', id: 's_test' },
  readerId: 'u_1',
  filters: listingFilters({}),
};
const place = { ts: NOW - 5000, id: '41' };

describe('the audit cursor', () => {
  const codec = createAuditCursorCodec(SECRET);

  it('comes back as the place it was given out for, and when its listing was opened', () => {
    const text = codec.issue(place, NOW, listing);
    expect(codec.read(text, listing, NOW + 1000)).toEqual({ after: place, openedAt: NOW });
    // One opaque string that travels in a query string as it is.
    expect(text).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('is nothing in another log, for another reader, or for another question', () => {
    const text = codec.issue(place, NOW, listing);
    for (const other of [
      { ...listing, scope: { kind: 'team' as const, id: 's_test' } },
      { ...listing, scope: { kind: 'site' as const, id: 's_other' } },
      { ...listing, readerId: 'u_2' },
      { ...listing, filters: listingFilters({ target: 'v_ada' }) },
      { ...listing, filters: listingFilters({ kind: 'identity' }) },
      { ...listing, filters: listingFilters({ from: 0 }) },
    ]) {
      expect(codec.read(text, other, NOW + 1000)).toBeNull();
    }
  });

  it('keeps its parts apart: what one binding ends with is never what the next begins with', () => {
    const left: AuditListing = { ...listing, scope: { kind: 'site', id: 's_a' }, readerId: 'b_c' };
    const right: AuditListing = { ...listing, scope: { kind: 'site', id: 's_a_b' }, readerId: 'c' };
    expect(codec.read(codec.issue(place, NOW, left), right, NOW)).toBeNull();
  });

  it('writes a different line for every different set of filters', () => {
    const lines = [
      listingFilters({}),
      listingFilters({ from: 1 }),
      listingFilters({ to: 1 }),
      listingFilters({ actorId: '1' }),
      listingFilters({ kind: '1' }),
      listingFilters({ target: '1' }),
      listingFilters({ actorId: 'a', target: 'b' }),
      listingFilters({ actorId: 'b', target: 'a' }),
    ];
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('is refused when any of it was changed, or it was signed with another secret', () => {
    const text = codec.issue(place, NOW, listing);
    const [body, signature] = text.split('.') as [string, string];
    const moved = Buffer.from(JSON.stringify([NOW + 999_999, '41', NOW])).toString('base64url');
    expect(codec.read(`${moved}.${signature}`, listing, NOW)).toBeNull();
    expect(codec.read(`${body}.${signature.slice(0, -1)}`, listing, NOW)).toBeNull();
    expect(codec.read(body, listing, NOW)).toBeNull();
    expect(codec.read(`.${signature}`, listing, NOW)).toBeNull();
    expect(codec.read('', listing, NOW)).toBeNull();
    expect(createAuditCursorCodec('another-secret').read(text, listing, NOW)).toBeNull();
  });

  it('lasts an hour from the opening and not a millisecond more', () => {
    const text = codec.issue(place, NOW, listing);
    expect(codec.read(text, listing, NOW + AUDIT_LISTING_MS - 1)).toEqual({ after: place, openedAt: NOW });
    expect(codec.read(text, listing, NOW + AUDIT_LISTING_MS)).toBe('expired');
    // A listing opened after now was not opened by this clock.
    expect(codec.read(text, listing, NOW - 1)).toBeNull();
  });

  it('is not a session, and a session is not a cursor, though both come from one secret', () => {
    const sessions = createSessionCodec(SECRET, 60_000);
    const session = sessions.issue('u_1', NOW).value;
    expect(codec.read(session, listing, NOW)).toBeNull();
    expect(sessions.read(codec.issue(place, NOW, listing), NOW)).toBeNull();
  });
});
