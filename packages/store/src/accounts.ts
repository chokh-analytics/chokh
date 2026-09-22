import { createHash } from 'node:crypto';

import type { GoalKind } from './query.js';

// The control plane: who may read a site, with what, and who read an identity.
//
// These rows are not analytics. They are the accounts, the teams, the API keys
// and the audit log that AN-API01 puts in front of the store, and they live
// here rather than in the server for the same reason the read plan does: rule 3
// says no query outside an adapter, so the shapes an adapter has to write have
// to be declared where every adapter can see them.

// What a caller is allowed to do. A key carries these directly; a dashboard
// session gets them from the role it holds in the team that owns the site.
//
// read:identity is the one that matters. An IP address, the userId an identify
// named and the traits that came with it are personal data about a real person,
// so they are behind a scope of their own and every read that passes it writes
// an audit row. See docs in packages/server/README.md.
export type Scope = 'read:stats' | 'read:identity' | 'write:events' | 'admin';

export const SCOPES: readonly Scope[] = ['read:stats', 'read:identity', 'write:events', 'admin'];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

// What a person is to a team. Owner runs it, editor changes settings and sends
// server side events, viewer reads. AN-TEAM01 grows this; AN-API01 lands the
// shape and the authorization that consults it.
export type Role = 'owner' | 'editor' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];

export interface TeamMember {
  userId: string;
  role: Role;
  // Whether this member may read addresses and identified people. An owner has
  // it by their role; an editor or a viewer only when somebody granted it, so
  // "can see the numbers" and "can see who the numbers are about" are two
  // different permissions the way they are in any product that takes privacy
  // seriously.
  identity: boolean;
}

export interface StoredTeam {
  id: string;
  name: string;
  members: TeamMember[];
}

// The team a site with no teamId belongs to. A single tenant install never
// names one, and the conformance fixture does not either, so rather than
// refusing those sites they are read as the default team's.
export const DEFAULT_TEAM_ID = 'default';

export interface StoredUser {
  id: string;
  // Lowercased on the way in, because an address is one address however it was
  // typed, and the unique index would otherwise let two of them exist.
  email: string;
  name?: string;
  // Argon2id. Absent for somebody the SSO exchange created, who has never set
  // a password and cannot log in with one until they do.
  passwordHash?: string;
  createdAt: number;
  lastLoginAt?: number;
}

export interface StoredApiKey {
  id: string;
  siteId: string;
  name: string;
  // SHA-256 of the token, hex. Not argon2: a key is 256 bits of randomness, so
  // there is nothing to guess and nothing for a slow hash to defend, and the
  // lookup is by hash through a unique index, which a salted slow hash cannot
  // do. A password is the opposite case and gets argon2id.
  keyHash: string;
  scopes: Scope[];
  createdAt: number;
  createdBy: string;
}

export type AuditActorKind = 'session' | 'key';

// One row per response that carried an address, a userId or a trait. Kept
// forever: the point of the log is the question "who looked at this person",
// which is asked months later.
export interface AuditRecord {
  siteId: string;
  ts: number;
  actor: { kind: AuditActorKind; id: string; email?: string };
  // What was exercised. Only 'read:identity' today, and a string rather than an
  // enum so a later ticket can log a write without a migration.
  action: string;
  // The route that answered, so a log line reads without a join.
  route: string;
  // The visitor or user the read was about, when it was about one.
  target?: string;
  // Which identity fields the response actually carried. A read that revealed
  // nothing writes no row at all.
  fields: string[];
}

// A goal's id, derived from what it asks rather than drawn at random.
//
// Two goals asking the same question would be the same numbers under two names,
// so the second is refused, and deriving the id is what lets the unique index on
// {siteId, id} refuse it without a read before the write or an index of its own.
// It also means deleting a goal and adding it again gives it back its id, which
// is right: nothing was counted under the old one.
export function goalIdFor(siteId: string, kind: GoalKind, match: string): string {
  const digest = createHash('sha256').update(`${siteId}\n${kind}\n${match}`).digest('base64url');
  return `g_${digest.slice(0, 16)}`;
}
