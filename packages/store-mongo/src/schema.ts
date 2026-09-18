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

export const schema: readonly CollectionSchema[] = [
  {
    name: SITES,
    purpose: 'One row per tracked site: its domains and its settings.',
    indexes: [
      { name: 'site_id', key: { id: 1 }, unique: true },
      // Multikey and unique together: a domain belongs to one site, so a key
      // stolen from another page cannot borrow somebody else's numbers.
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
    purpose: 'A visitor stay. Declared and indexed here, written by AN-SES01.',
    indexes: [
      { name: 'session_site_id', key: { siteId: 1, id: 1 }, unique: true },
      { name: 'session_site_last_seen', key: { siteId: 1, lastSeenAt: 1 } },
      { name: 'session_site_visitor', key: { siteId: 1, visitorId: 1 } },
      { name: 'session_site_user', key: { siteId: 1, userId: 1 } },
    ],
  },
  {
    name: VISITORS,
    purpose: 'The person behind the sessions. Declared here, written by AN-SES01.',
    indexes: [
      { name: 'visitor_site_id', key: { siteId: 1, id: 1 }, unique: true },
      {
        name: 'visitor_site_user',
        key: { siteId: 1, userId: 1 },
        unique: true,
        // Sparse would let many rows without a userId coexist, but a partial
        // index says it in a way the query planner can also use.
        partialFilterExpression: { userId: { $exists: true } },
      },
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
    name: 'users',
    purpose: 'Dashboard accounts. Fields arrive with AN-API01.',
    indexes: [{ name: 'user_email', key: { email: 1 }, unique: true }],
  },
  {
    name: 'teams',
    purpose: 'Owner, editor and viewer membership. Fields arrive with AN-TEAM01.',
    indexes: [{ name: 'team_id', key: { id: 1 }, unique: true }],
  },
  {
    name: 'api_keys',
    purpose: 'Hashed keys and their scopes. Fields arrive with AN-API01.',
    indexes: [
      { name: 'api_key_hash', key: { keyHash: 1 }, unique: true },
      { name: 'api_key_site', key: { siteId: 1 } },
    ],
  },
  {
    name: 'audit_log',
    purpose: 'Who read an IP or an identified person. Kept forever.',
    indexes: [{ name: 'audit_site_ts', key: { siteId: 1, ts: 1 } }],
  },
];

export const DECLARED_INDEX_COUNT = schema.reduce(
  (total, collection) => total + collection.indexes.length,
  0,
);
