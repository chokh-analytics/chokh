import { createHash } from 'node:crypto';

import type {
  AlertCondition,
  AnnotationKind,
  Filter,
  FunnelWindow,
  GoalKind,
  GoalMatch,
} from './query.js';

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

// A segment's filters in the one order the id is derived from: by dimension,
// then operator, then value, with a filter listed twice kept once. The same
// set is one segment however a filter bar happened to list it.
export function canonicalFilters(filters: readonly Filter[]): Filter[] {
  const seen = new Set<string>();
  const kept: Filter[] = [];
  for (const filter of [...filters].sort(compareFilters)) {
    const key = JSON.stringify([filter.dim, filter.op, filter.value]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ dim: filter.dim, op: filter.op, value: filter.value });
  }
  return kept;
}

function compareFilters(left: Filter, right: Filter): number {
  return (
    left.dim.localeCompare(right.dim) ||
    left.op.localeCompare(right.op) ||
    left.value.localeCompare(right.value)
  );
}

// A segment's id, derived from what it saves, for the reason a goal's is: the
// same filters saved under two names are the same rows twice, so the second is
// refused by the unique index on {siteId, id} with no read before the write.
// The name is not part of it. Encoded as JSON, as a funnel's is, so a value
// holding any character still spells one question.
export function segmentIdFor(siteId: string, filters: readonly Filter[]): string {
  const question = JSON.stringify([
    siteId,
    canonicalFilters(filters).map((filter) => [filter.dim, filter.op, filter.value]),
  ]);
  const digest = createHash('sha256').update(question).digest('base64url');
  return `sg_${digest.slice(0, 16)}`;
}

// An annotation's id, derived from the fact it states: the site, the instant,
// the kind and the text. A deploy pipeline that retries its POST, or a person
// who presses Save twice, writes one mark and not two, and the unique index on
// {siteId, id} is what refuses the second with no read before the write. The
// link is not part of it: the same fact with a different link is still the
// same fact.
export function annotationIdFor(
  siteId: string,
  at: number,
  kind: AnnotationKind,
  text: string,
): string {
  const question = JSON.stringify([siteId, at, kind, text]);
  const digest = createHash('sha256').update(question).digest('base64url');
  return `an_${digest.slice(0, 16)}`;
}

// An alert's condition with its fields in one order, so the same question
// spelled by two forms is one string. The channels are not in it: where an
// answer is sent is not part of the question.
export function canonicalCondition(condition: AlertCondition): string {
  const entries = Object.entries(condition).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

// An alert's id, derived from the question the way a goal's is: one question
// is one alert, and the unique index on {siteId, id} refuses a second under
// another name with no read before the write.
export function alertIdFor(siteId: string, condition: AlertCondition): string {
  const question = JSON.stringify([siteId, canonicalCondition(condition)]);
  const digest = createHash('sha256').update(question).digest('base64url');
  return `al_${digest.slice(0, 16)}`;
}

// A digest's id: the site and the cadence, nothing else, so a site has one
// daily and one weekly and the unique index on {siteId, id} refuses a second.
export function digestIdFor(siteId: string, cadence: 'daily' | 'weekly'): string {
  const digest = createHash('sha256').update(JSON.stringify([siteId, cadence])).digest('base64url');
  return `dg_${digest.slice(0, 16)}`;
}

// A funnel's id, derived from what it asks, for the reason a goal's is: the
// same steps in the same order within the same window are the same numbers, so
// the second is refused by the unique index on {siteId, id} with no read before
// the write. The name is not part of it, and a step's goalId is not either: a
// step is the question it copied, wherever the question came from.
//
// Encoded as JSON rather than joined with separators. A typed path may hold any
// character, a tab and a newline included, so a joined spelling lets one step
// holding both read as two steps; JSON quotes every string, and no two
// different questions spell the same text.
export function funnelIdFor(siteId: string, window: FunnelWindow, steps: GoalMatch[]): string {
  const question = JSON.stringify([siteId, window, steps.map((step) => [step.kind, step.match])]);
  const digest = createHash('sha256').update(question).digest('base64url');
  return `f_${digest.slice(0, 16)}`;
}
