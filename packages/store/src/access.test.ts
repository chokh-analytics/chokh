import { describe, expect, it } from 'vitest';

import {
  MAX_AUDIT_PAGE,
  changedMembers,
  checkAuditPage,
  checkAuditRow,
  checkInvitation,
  invitationState,
  matchesAudit,
  type AuditPageQuery,
  type StoredInvitation,
} from './access.js';
import type { AuditRecord, TeamMember } from './accounts.js';
import { StoreQueryError } from './query.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof StoreQueryError) return error.code;
    throw error;
  }
  return 'NOTHING_WAS_REFUSED';
}

const owner = (userId: string): TeamMember => ({ userId, role: 'owner', identity: true });
const viewer = (userId: string): TeamMember => ({ userId, role: 'viewer', identity: false });

describe('changedMembers', () => {
  const none = new Set<string>();

  it('adds at the end, changes in place and removes, without touching what it was given', () => {
    const members = [owner('a'), viewer('b')];
    const added = changedMembers(members, 'c', { role: 'editor', identity: false }, none);
    expect(added.map((member) => member.userId)).toEqual(['a', 'b', 'c']);
    const changed = changedMembers(added, 'b', { role: 'editor', identity: true }, none);
    expect(changed[1]).toEqual({ userId: 'b', role: 'editor', identity: true });
    expect(changedMembers(changed, 'b', null, none).map((member) => member.userId)).toEqual([
      'a',
      'c',
    ]);
    expect(members).toEqual([owner('a'), viewer('b')]);
  });

  it('refuses taking out somebody who is not there', () => {
    expect(codeOf(() => changedMembers([owner('a')], 'z', null, none))).toBe('UNKNOWN_MEMBER');
  });

  it('keeps an owner in a team that has one', () => {
    const members = [owner('a'), viewer('b')];
    expect(codeOf(() => changedMembers(members, 'a', null, none))).toBe('LAST_OWNER');
    expect(
      codeOf(() => changedMembers(members, 'a', { role: 'editor', identity: true }, none)),
    ).toBe('LAST_OWNER');
    // With a second owner either may go.
    const two = [owner('a'), owner('b')];
    expect(changedMembers(two, 'a', null, none)).toEqual([owner('b')]);
  });

  it('keeps an owner with a password in a team that has one', () => {
    const members = [owner('local'), owner('elsewhere')];
    const holders = new Set(['local']);
    expect(codeOf(() => changedMembers(members, 'local', null, holders))).toBe('LAST_OWNER');
    expect(
      codeOf(() => changedMembers(members, 'local', { role: 'viewer', identity: false }, holders)),
    ).toBe('LAST_OWNER');
    expect(changedMembers(members, 'elsewhere', null, holders)).toEqual([owner('local')]);
    // A member with a password who is not an owner protects nothing.
    const mixed = [owner('elsewhere'), viewer('local')];
    expect(changedMembers(mixed, 'local', null, holders)).toEqual([owner('elsewhere')]);
  });

  it('has nothing to protect in a team that never had an owner', () => {
    expect(changedMembers([viewer('a')], 'a', null, none)).toEqual([]);
    expect(changedMembers([], 'a', { role: 'owner', identity: true }, none)).toEqual([owner('a')]);
  });
});

describe('invitationState', () => {
  const open = { expiresAt: NOW + 1000 };

  it('is pending until the instant it expires, and expired from that instant', () => {
    expect(invitationState(open, NOW + 999)).toBe('pending');
    expect(invitationState(open, NOW + 1000)).toBe('expired');
  });

  it('reads accepted and revoked off the row, whatever the clock says', () => {
    expect(invitationState({ ...open, acceptedAt: NOW }, NOW + 5000)).toBe('accepted');
    expect(invitationState({ ...open, revokedAt: NOW }, NOW)).toBe('revoked');
  });
});

describe('checkInvitation', () => {
  const good: StoredInvitation = {
    id: 'inv_1',
    tokenHash: 'h',
    email: 'a@example.com',
    scope: { kind: 'team', id: 't' },
    role: 'viewer',
    identity: false,
    invitedBy: 'u_1',
    createdAt: NOW,
    expiresAt: NOW + 1,
  };

  it('accepts an open invitation and refuses everything else', () => {
    expect(codeOf(() => checkInvitation(good))).toBe('NOTHING_WAS_REFUSED');
    const bad: StoredInvitation[] = [
      { ...good, id: '' },
      { ...good, tokenHash: '' },
      { ...good, email: '' },
      { ...good, scope: { kind: 'site', id: '' } },
      { ...good, scope: { kind: 'world' as 'team', id: 'x' } },
      { ...good, role: 'admin' as 'owner' },
      { ...good, expiresAt: NOW },
      { ...good, acceptedBy: 'u_2' },
      { ...good, revokedBy: 'u_2' },
    ];
    for (const each of bad) {
      expect(codeOf(() => checkInvitation(each))).toBe('INVALID_INVITATION');
    }
  });
});

describe('the audit log rules', () => {
  const base: AuditRecord = {
    siteId: 's_1',
    ts: NOW,
    actor: { kind: 'session', id: 'u_1' },
    action: 'read:identity',
    route: 'GET /x',
    target: 'ada',
    fields: ['ip'],
  };

  it('takes a row about a site or a team, and neither both nor neither', () => {
    expect(codeOf(() => checkAuditRow(base))).toBe('NOTHING_WAS_REFUSED');
    const { siteId: _siteId, ...bare } = base;
    expect(codeOf(() => checkAuditRow({ ...bare, teamId: 't_1' }))).toBe('NOTHING_WAS_REFUSED');
    expect(codeOf(() => checkAuditRow({ ...base, teamId: 't_1' }))).toBe('INVALID_AUDIT_ROW');
    expect(codeOf(() => checkAuditRow(bare))).toBe('INVALID_AUDIT_ROW');
    expect(codeOf(() => checkAuditRow({ ...bare, siteId: '', teamId: '' }))).toBe(
      'INVALID_AUDIT_ROW',
    );
  });

  it('serves a page of 1 to the ceiling', () => {
    const query = (limit: number): AuditPageQuery => ({ scope: { kind: 'site', id: 's' }, limit });
    expect(codeOf(() => checkAuditPage(query(1)))).toBe('NOTHING_WAS_REFUSED');
    expect(codeOf(() => checkAuditPage(query(MAX_AUDIT_PAGE)))).toBe('NOTHING_WAS_REFUSED');
    for (const limit of [0, MAX_AUDIT_PAGE + 1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => checkAuditPage(query(limit)))).toBe('INVALID_AUDIT_QUERY');
    }
    expect(
      codeOf(() => checkAuditPage({ ...query(5), after: { ts: Number.NaN, id: '1' } })),
    ).toBe('INVALID_CURSOR');
  });

  it('matches a row by its scope first, then by every filter given', () => {
    const site: AuditPageQuery = { scope: { kind: 'site', id: 's_1' }, limit: 10 };
    expect(matchesAudit(base, site)).toBe(true);
    expect(matchesAudit(base, { ...site, scope: { kind: 'team', id: 's_1' } })).toBe(false);
    expect(matchesAudit(base, { ...site, from: NOW, to: NOW + 1 })).toBe(true);
    expect(matchesAudit(base, { ...site, from: NOW + 1 })).toBe(false);
    expect(matchesAudit(base, { ...site, to: NOW })).toBe(false);
    expect(matchesAudit(base, { ...site, actorId: 'u_2' })).toBe(false);
    expect(matchesAudit(base, { ...site, actions: ['member:set'] })).toBe(false);
    expect(matchesAudit(base, { ...site, actions: [] })).toBe(false);
    expect(matchesAudit(base, { ...site, target: 'ad' })).toBe(false);
    expect(matchesAudit(base, { ...site, target: 'ada', actorId: 'u_1' })).toBe(true);
  });
});
