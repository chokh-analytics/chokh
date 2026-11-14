import {
  DEFAULT_TEAM_ID,
  ROLES,
  type Role,
  type Scope,
  type Site,
  type SiteMember,
  type StoredTeam,
  type TeamMember,
} from '../store/AnalyticsStore.js';

// What a role may do, in one table.
//
// A key carries its scopes directly, because whoever minted it chose them. A
// dashboard session does not: it holds a role in the team that owns the site, and
// the role decides. Keeping both in the same currency is what lets one
// authorization check serve a browser and a backend.
//
// read:identity is deliberately not in the editor's or the viewer's list. An owner
// has it because they run the site; anybody else only when it was granted on their
// membership. "Can read the numbers" and "can read who the numbers are about" are
// two permissions, which is the whole point of the identity gate.
const ROLE_SCOPES: Readonly<Record<Role, readonly Scope[]>> = {
  owner: ['read:stats', 'read:identity', 'write:events', 'admin'],
  editor: ['read:stats', 'write:events'],
  viewer: ['read:stats'],
};

export function scopesForRole(role: Role, identity: boolean): Set<Scope> {
  const scopes = new Set<Scope>(ROLE_SCOPES[role]);
  if (identity) {
    scopes.add('read:identity');
  }
  return scopes;
}

// What one caller may do to one site. The role is present for a session and
// absent for a key, because a key has no role: somebody with a role minted it and
// chose which of their scopes it carries.
export interface Grant {
  scopes: Set<Scope>;
  role?: Role;
}

// Who is asking.
//
// grantFor is a function rather than a map because a session's answer depends on
// the site: the same person can be an owner of one team and a viewer of another.
// It answers null when this caller may not touch the site at all, which a route
// turns into 403 and never into an empty report.
export interface Principal {
  kind: 'session' | 'key' | 'share';
  // The user id for a session, the key id for a key. This is what an audit row
  // records as the actor.
  id: string;
  email?: string;
  grantFor(site: Site): Grant | null;
}

// A site with no team belongs to the default team. A single tenant install never
// names one and neither does the conformance fixture, and refusing those sites
// would mean a fresh install could read nothing.
export function teamIdOf(site: Site): string {
  return site.teamId ?? DEFAULT_TEAM_ID;
}

// What one person may do on one site (AN-TEAM01), from the two things they
// can hold: a role in the team that owns the site, and a role on the site
// itself. In this order, and the order is the rule:
//
// 1. An owner of the team is an owner of every site in it. No row on a site
//    can lower that, so nobody can be shut out of a site their team owns by
//    somebody a rung below them, and an owner cannot be quietly reduced.
// 2. Otherwise the row on the site decides, when there is one. It may give
//    more than the team role does or less: a viewer of the team who runs one
//    site, an editor everywhere who only reads this one.
// 3. Otherwise the team role.
// 4. Otherwise nothing, which a route answers with 403 and never with an
//    empty report.
//
// A person may hold a row on a site and no place in its team at all: somebody
// invited to see one site sees that one.
export function grantOn(
  member: Pick<TeamMember, 'role' | 'identity'> | undefined,
  row: Pick<SiteMember, 'role' | 'identity'> | undefined,
): Grant | null {
  if (member?.role === 'owner') {
    return { scopes: scopesForRole('owner', true), role: 'owner' };
  }
  const held = row ?? member;
  if (held === undefined) {
    return null;
  }
  return { scopes: scopesForRole(held.role, held.identity), role: held.role };
}

// How far up a role is. Used to tell a change that lowers somebody from one
// that does not, never to decide what anybody may do: that is the table above.
export function roleRank(role: Role): number {
  // owner, editor, viewer in ROLES; the first is the highest.
  return ROLES.length - ROLES.indexOf(role);
}

export function sessionPrincipal(
  userId: string,
  email: string,
  teams: StoredTeam[],
  siteRows: readonly SiteMember[] = [],
): Principal {
  const byTeam = new Map(teams.map((team) => [team.id, team]));
  const bySite = new Map(siteRows.map((row) => [row.siteId, row]));
  return {
    kind: 'session',
    id: userId,
    email,
    grantFor(site: Site): Grant | null {
      const member = byTeam
        .get(teamIdOf(site))
        ?.members.find((candidate) => candidate.userId === userId);
      return grantOn(member, bySite.get(site.id));
    },
  };
}

export function keyPrincipal(keyId: string, siteId: string, scopes: Scope[]): Principal {
  return {
    kind: 'key',
    id: keyId,
    grantFor(site: Site): Grant | null {
      // A key belongs to one site. Presenting it at another is not a smaller
      // permission, it is the wrong key.
      return site.id === siteId ? { scopes: new Set(scopes) } : null;
    },
  };
}

// Whoever holds a share link (AN-RPT01): read:stats on that one site and
// nothing else, so the report controllers serve the public page unchanged
// and the same rules apply to it.
export function sharePrincipal(siteId: string): Principal {
  return {
    kind: 'share',
    id: `share:${siteId}`,
    grantFor(site: Site): Grant | null {
      return site.id === siteId ? { scopes: new Set<Scope>(['read:stats']) } : null;
    },
  };
}
