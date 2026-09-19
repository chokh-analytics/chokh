import type {
  RealtimeSnapshot,
  RealtimeVisitor,
  UserProfile,
  VisitorProfile,
} from '../store/AnalyticsStore.js';

// The one place a response is stripped of who it is about.
//
// Three kinds of field are personal data about a real person rather than a fact
// about traffic: the address a request came from, the userId an identify named,
// and the traits that came with it. AGENTS.md section 5 puts them behind the
// read:identity scope, and every response that carries one writes an audit row.
//
// Both halves are here on purpose. A route that strips in one place and logs in
// another eventually logs a read it did not make, or makes one it did not log;
// these functions answer with the payload and with the list of fields that
// survived, so the audit row is drawn from the same pass that built the body.
// An empty list means nothing personal was revealed and nothing is written.

export const IDENTITY_FIELDS = ['ip', 'ips', 'userId', 'traits'] as const;

export interface Gated<T> {
  value: T;
  // The identity fields this payload actually carries, sorted, for the audit
  // row. Empty when the caller had no scope, and also empty when they had it and
  // the answer happened to contain nothing personal.
  fields: string[];
}

function gatedVisitor(visitor: RealtimeVisitor, allowed: boolean, found: Set<string>): RealtimeVisitor {
  if (allowed) {
    if (visitor.ip !== undefined) found.add('ip');
    if (visitor.userId !== undefined) found.add('userId');
    return visitor;
  }
  const { ip: _ip, userId: _userId, ...rest } = visitor;
  return rest;
}

// The live list stays visible to anybody who may read the site's numbers: the
// page, the country, the city, the device and how long they have been here are
// traffic. The address and the name are not, so those two fields are what the
// scope gates, which is the column the dashboard hides rather than the whole
// list. The online, signed in and anonymous counts are counts and are never
// gated: "seventeen people are here, four of them signed in" names nobody.
export function gateRealtime(snapshot: RealtimeSnapshot, allowed: boolean): Gated<RealtimeSnapshot> {
  const found = new Set<string>();
  const visitors = snapshot.visitors.map((visitor) => gatedVisitor(visitor, allowed, found));
  // The people who were here a few minutes ago are the same people, so they go
  // through the same strip. A second list that forgot to would be the whole
  // gate undone by the list nobody was looking at.
  const recent = snapshot.recent.map((visitor) => gatedVisitor(visitor, allowed, found));
  return { value: { ...snapshot, visitors, recent }, fields: [...found].sort() };
}

export function gateVisitorProfile(
  profile: VisitorProfile,
  allowed: boolean,
): Gated<VisitorProfile> {
  const found = new Set<string>();
  if (allowed) {
    if (profile.ips.length > 0) found.add('ips');
    if (profile.userId !== undefined) found.add('userId');
    if (profile.traits !== undefined) found.add('traits');
    return { value: profile, fields: [...found].sort() };
  }
  const { userId: _userId, traits: _traits, ...rest } = profile;
  return { value: { ...rest, ips: [] }, fields: [] };
}

// A user profile is only ever reached by naming the person, so the route refuses
// it outright without the scope and this never strips. It is here for the field
// list, so one pass builds the body and the audit row.
export function identityFieldsOfUser(profile: UserProfile): string[] {
  const found = new Set<string>(['userId']);
  if (profile.ips.length > 0) found.add('ips');
  if (profile.traits !== undefined) found.add('traits');
  return [...found].sort();
}
