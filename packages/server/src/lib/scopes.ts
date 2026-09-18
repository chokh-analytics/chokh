import {
  DEFAULT_TEAM_ID,
  type Role,
  type Scope,
  type Site,
  type StoredTeam,
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
  kind: 'session' | 'key';
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

export function sessionPrincipal(userId: string, email: string, teams: StoredTeam[]): Principal {
  const byTeam = new Map(teams.map((team) => [team.id, team]));
  return {
    kind: 'session',
    id: userId,
    email,
    grantFor(site: Site): Grant | null {
      const member = byTeam
        .get(teamIdOf(site))
        ?.members.find((candidate) => candidate.userId === userId);
      if (member === undefined) {
        return null;
      }
      return { scopes: scopesForRole(member.role, member.identity), role: member.role };
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
