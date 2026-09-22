import type { IndexDescription } from 'mongodb';

// The one declaration of what this database looks like. Nothing else in the
// repository creates an index: `migrate --apply` reads this file and applies
// it, `migrate --verify-only` reads this file and reports what is missing, and
// the adapter never touches indexes at all. That is what "never autoIndex"
// means here, and a test holds us to it.

export interface CollectionSchema {
  name: string;
  // Why the collection exists, printed by migrate so an operator reading the
  // report knows what it is looking at.
  purpose: string;
  indexes: IndexDescription[];
}

export const EVENTS = 'events';
export const SITES = 'sites';
export const SESSIONS = 'sessions';
export const VISITORS = 'visitors';
export const ROLLUPS_DAILY = 'rollups_daily';
export const USERS = 'users';
export const TEAMS = 'teams';
export const API_KEYS = 'api_keys';
export const AUDIT_LOG = 'audit_log';
export const GOALS = 'goals';

export const schema: readonly CollectionSchema[] = [
  {
    name: SITES,
    purpose: 'One row per tracked site: its domains and its settings.',
    indexes: [
      { name: 'site_id', key: { id: 1 }, unique: true },
      // Multikey and unique together: a domain belongs to one site, so a key
      // stolen from another page cannot borrow somebody else's numbers.
      //
      // Multikey also means an empty array indexes as one null key, so two sites
      // with no domains would collide on it. That is why createSite refuses an
      // empty domain list rather than letting the driver report a duplicate key
      // for a reason nobody could read.
      { name: 'site_domains', key: { domains: 1 }, unique: true },
    ],
  },
  {
    name: EVENTS,
    purpose: 'Raw events. Aged out by the TTL below, at the site retention.',
    indexes: [
      { name: 'event_site_ts', key: { siteId: 1, ts: 1 } },
      { name: 'event_site_session', key: { siteId: 1, sessionId: 1 } },
      { name: 'event_site_user_ts', key: { siteId: 1, userId: 1, ts: 1 } },
      // Not in the plan's table, added because visitor() reads by it and would
      // otherwise scan a site's whole history to profile one person.
      { name: 'event_site_visitor_ts', key: { siteId: 1, visitorId: 1, ts: 1 } },
      // MongoDB expires a whole collection at one age, so the per-site
      // retention rides on the document: ingest stamps expiresAt from the
      // site's retentionDays and this index honours it to the second.
      { name: 'event_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  },
  {
    name: SESSIONS,
    purpose: 'A visitor stay: one row per unbroken run of their events.',
    indexes: [
      { name: 'session_site_id', key: { siteId: 1, id: 1 }, unique: true },
      // A visit belongs to the day it began on, so every read of the session
      // side cuts by startedAt.
      { name: 'session_site_started', key: { siteId: 1, startedAt: 1 } },
      { name: 'session_site_last_seen', key: { siteId: 1, lastSeenAt: 1 } },
      // Newest first, because ingest asks this collection one question on every
      // batch: which stay is this visitor's latest.
      { name: 'session_site_visitor', key: { siteId: 1, visitorId: 1, startedAt: -1 } },
      { name: 'session_site_user', key: { siteId: 1, userId: 1 } },
      // Per-site retention, the same way an event carries it.
      { name: 'session_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  },
  {
    name: VISITORS,
    purpose: 'The person behind the sessions: their counts, devices and touches.',
    indexes: [
      { name: 'visitor_site_id', key: { siteId: 1, id: 1 }, unique: true },
      {
        name: 'visitor_site_user',
        key: { siteId: 1, userId: 1 },
        // Not unique: two browsers are two visitors, and the same person
        // signing in on both is exactly what a user lookup has to join.
      },
      // Rewritten on every visit, so a visitor who keeps coming back keeps
      // their row, and one who stops loses it at the site's retention.
      { name: 'visitor_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  },
  {
    name: ROLLUPS_DAILY,
    purpose: 'One row per site, day, dimension and value. Kept forever.',
    indexes: [
      { name: 'rollup_key', key: { siteId: 1, date: 1, dim: 1, key: 1 }, unique: true },
      // Not in the plan's table, added because a breakdown over a range reads
      // one dimension across many days, which the unique key cannot lead with.
      { name: 'rollup_site_dim_date', key: { siteId: 1, dim: 1, date: 1 } },
    ],
  },

  // The config rows. Their identity index is settled here because the
  // migration has to create the collection anyway; their fields arrive with
  // the tickets that own them.
  ...['goals', 'funnels', 'annotations', 'alerts', 'reports', 'segments'].map(
    (name): CollectionSchema => ({
      name,
      purpose: `Site scoped configuration. Fields arrive with the ticket that owns ${name}.`,
      indexes: [{ name: `${name}_site_id`, key: { siteId: 1, id: 1 }, unique: true }],
    }),
  ),
  {
    name: USERS,
    purpose: 'Dashboard accounts: an address, an argon2id hash and a name.',
    indexes: [
      { name: 'user_id', key: { id: 1 }, unique: true },
      // Lowercased by the adapter on the way in, because one address is one
      // address however it was typed and this index would otherwise hold both.
      { name: 'user_email', key: { email: 1 }, unique: true },
    ],
  },
  {
    name: TEAMS,
    purpose: 'Who may read which sites: owner, editor and viewer membership.',
    indexes: [
      { name: 'team_id', key: { id: 1 }, unique: true },
      // "Which teams is this person in" is asked on every dashboard request, so
      // it is a multikey index rather than a scan of every team.
      { name: 'team_members', key: { 'members.userId': 1 } },
    ],
  },
  {
    name: API_KEYS,
    purpose: 'Hashed keys and their scopes. The hash is SHA-256 of the token.',
    indexes: [
      // The one read on the authentication path, so it has to be an index.
      { name: 'api_key_hash', key: { keyHash: 1 }, unique: true },
      { name: 'api_key_site', key: { siteId: 1 } },
    ],
  },
  {
    name: AUDIT_LOG,
    purpose: 'Who read an IP or an identified person. Kept forever, no TTL.',
    indexes: [{ name: 'audit_site_ts', key: { siteId: 1, ts: 1 } }],
  },
];

export const DECLARED_INDEX_COUNT = schema.reduce(
  (total, collection) => total + collection.indexes.length,
  0,
);
