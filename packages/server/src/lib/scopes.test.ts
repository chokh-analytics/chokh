import { describe, expect, it } from 'vitest';

import { grantOn, keyPrincipal, roleRank, scopesForRole, sessionPrincipal, teamIdOf } from './scopes.js';
import { defaultSiteSettings, type Site, type StoredTeam } from '../store/AnalyticsStore.js';

function site(overrides: Partial<Site> = {}): Site {
  return {
    id: 's_one',
    name: 'One',
    domains: ['one.example'],
    teamId: 't_one',
    settings: defaultSiteSettings(),
    ...overrides,
  };
}

const team: StoredTeam = {
  id: 't_one',
  name: 'One',
  members: [
    { userId: 'u_owner', role: 'owner', identity: true },
    { userId: 'u_editor', role: 'editor', identity: false },
    { userId: 'u_viewer', role: 'viewer', identity: false },
    { userId: 'u_viewer_plus', role: 'viewer', identity: true },
  ],
};

describe('scopesForRole', () => {
  it('gives an owner everything', () => {
    expect([...scopesForRole('owner', false)].sort()).toEqual([
      'admin',
      'read:identity',
      'read:stats',
      'write:events',
    ]);
  });

  // The whole point of the identity gate: reading the numbers and reading who the
  // numbers are about are two permissions.
  it('withholds read:identity from an editor and a viewer until it is granted', () => {
    expect(scopesForRole('editor', false).has('read:identity')).toBe(false);
    expect(scopesForRole('viewer', false).has('read:identity')).toBe(false);
    expect(scopesForRole('viewer', true).has('read:identity')).toBe(true);
    // Granting identity does not grant anything else.
    expect([...scopesForRole('viewer', true)].sort()).toEqual(['read:identity', 'read:stats']);
  });

  it('gives an editor the write side and not the admin side', () => {
    expect([...scopesForRole('editor', false)].sort()).toEqual(['read:stats', 'write:events']);
  });
});

describe('a session principal', () => {
  it('answers with the role it holds in the team that owns the site', () => {
    const grant = sessionPrincipal('u_editor', 'e@x.example', [team]).grantFor(site());
    expect(grant?.role).toBe('editor');
    expect(grant?.scopes.has('write:events')).toBe(true);
  });

  it('answers null for a site whose team they are not in', () => {
    const principal = sessionPrincipal('u_viewer', 'v@x.example', [team]);
    expect(principal.grantFor(site({ teamId: 't_somebody_else' }))).toBeNull();
  });

  // A site created before teams existed, or by a single tenant install that never
  // names one. Refusing them would mean a fresh install could read nothing.
  it('reads a site with no team as the default team', () => {
    const withDefault: StoredTeam = {
      id: 'default',
      name: 'Default',
      members: [{ userId: 'u_owner', role: 'owner', identity: true }],
    };
    const principal = sessionPrincipal('u_owner', 'o@x.example', [withDefault]);
    const bare = site({ teamId: undefined });
    expect(teamIdOf(bare)).toBe('default');
    expect(principal.grantFor(bare)?.role).toBe('owner');
  });

  it('can be an owner of one team and a viewer of another', () => {
    const other: StoredTeam = {
      id: 't_two',
      name: 'Two',
      members: [{ userId: 'u_owner', role: 'viewer', identity: false }],
    };
    const principal = sessionPrincipal('u_owner', 'o@x.example', [team, other]);
    expect(principal.grantFor(site())?.role).toBe('owner');
    expect(principal.grantFor(site({ id: 's_two', teamId: 't_two' }))?.role).toBe('viewer');
  });
});

describe('a key principal', () => {
  it('carries the scopes it was minted with and no role', () => {
    const grant = keyPrincipal('k_1', 's_one', ['read:stats', 'write:events']).grantFor(site());
    expect(grant?.role).toBeUndefined();
    expect([...(grant?.scopes ?? [])].sort()).toEqual(['read:stats', 'write:events']);
  });

  // Presenting a key at another site is not a smaller permission, it is the wrong
  // key.
  it('answers null for any site but its own', () => {
    const principal = keyPrincipal('k_1', 's_one', ['read:stats']);
    expect(principal.grantFor(site({ id: 's_two' }))).toBeNull();
  });
});

// The order a grant is decided in, which is the rule (AN-TEAM01).
describe('a role in the team and a role on the site', () => {
  const sorted = (grant: ReturnType<typeof grantOn>): string[] => [...(grant?.scopes ?? [])].sort();
  const everything = ['admin', 'read:identity', 'read:stats', 'write:events'];

  it('makes an owner of the team an owner of the site, whatever the row on the site says', () => {
    for (const row of [undefined, { role: 'viewer', identity: false }, { role: 'editor', identity: false }] as const) {
      const grant = grantOn({ role: 'owner', identity: false }, row);
      expect(grant?.role).toBe('owner');
      expect(sorted(grant)).toEqual(everything);
    }
  });

  it('takes the row on the site in place of the team role, up or down', () => {
    expect(grantOn({ role: 'viewer', identity: false }, { role: 'owner', identity: true })?.role).toBe('owner');
    const lowered = grantOn({ role: 'editor', identity: true }, { role: 'viewer', identity: false });
    expect(lowered?.role).toBe('viewer');
    // The flag is the row's too: the team's does not leak through it.
    expect(sorted(lowered)).toEqual(['read:stats']);
  });

  it('falls back to the team role, and to nothing', () => {
    expect(sorted(grantOn({ role: 'editor', identity: false }, undefined))).toEqual([
      'read:stats',
      'write:events',
    ]);
    expect(sorted(grantOn(undefined, { role: 'viewer', identity: true }))).toEqual([
      'read:identity',
      'read:stats',
    ]);
    expect(grantOn(undefined, undefined)).toBeNull();
  });

  it('reads a session by it: a row on one site is about that site only', () => {
    const principal = sessionPrincipal('u_viewer', 'v@x.example', [team], [
      { siteId: 's_one', userId: 'u_viewer', role: 'owner', identity: true },
    ]);
    expect(principal.grantFor(site())?.role).toBe('owner');
    expect(principal.grantFor(site({ id: 's_other' }))?.role).toBe('viewer');
    // No place in the team and a row on one of its sites: that site, no other.
    const guest = sessionPrincipal('u_guest', 'g@x.example', [], [
      { siteId: 's_one', userId: 'u_guest', role: 'viewer', identity: false },
    ]);
    expect(guest.grantFor(site())?.role).toBe('viewer');
    expect(guest.grantFor(site({ id: 's_other' }))).toBeNull();
  });

  it('ranks the roles owner, editor, viewer', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('editor'));
    expect(roleRank('editor')).toBeGreaterThan(roleRank('viewer'));
  });
});
