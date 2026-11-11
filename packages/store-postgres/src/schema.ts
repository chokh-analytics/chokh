// The one declaration of what this database looks like. Nothing else in the
// repository creates a table or an index: `migrate --apply` reads this file
// and applies it, `migrate --verify-only` reads this file and reports what is
// missing, and the adapter creates nothing except a month's partition of
// events (partitions.ts says why that one thing is different).
//
// Three rules run through every table.
//
// A column for anything a WHERE, a GROUP BY, an ORDER BY or a constraint reads;
// JSONB for what is stored and handed back whole.
//
// Time is bigint Unix milliseconds, the contract's own unit, never timestamptz.
// There is no conversion to get wrong, and the database's time zone data is
// never consulted: the contract draws every day and bucket line, and SQL only
// groups by the lines it is handed.
//
// Every text column is COLLATE "C", so a comparison and an index order are by
// bytes on every install, whatever locale the database was created with. That
// is the order MongoDB's simple collation gives, so the two adapters break a
// tie the same way.

export interface ColumnSchema {
  name: string;
  // Everything after the name in the column's definition.
  definition: string;
}

export interface IndexSchema {
  name: string;
  // Everything after `ON <table>` in CREATE INDEX: the method, the keys and
  // the predicate.
  definition: string;
  unique?: boolean;
}

export interface TableSchema {
  name: string;
  // Why the table exists, printed by migrate so an operator reading the report
  // knows what it is looking at.
  purpose: string;
  columns: ColumnSchema[];
  // The primary key's columns. Absent on events, which the contract gives no
  // identity: the same batch sent twice is two sets of rows in every adapter.
  primaryKey?: string[];
  // Appended to CREATE TABLE after the closing bracket.
  partitionBy?: string;
  indexes: IndexSchema[];
}

export const EVENTS = 'events';
export const SESSIONS = 'sessions';
export const VISITORS = 'visitors';
export const ROLLUPS_DAILY = 'rollups_daily';
export const SITES = 'sites';
export const SITE_DOMAINS = 'site_domains';
export const GOALS = 'goals';
export const FUNNELS = 'funnels';
export const SEGMENTS = 'segments';
export const ANNOTATIONS = 'annotations';
export const ALERTS = 'alerts';
export const DIGESTS = 'digests';
export const USERS = 'users';
export const TEAMS = 'teams';
export const API_KEYS = 'api_keys';
export const AUDIT_LOG = 'audit_log';

// What gives two events of one millisecond an order. A sequence rather than an
// identity column, because a partition made LIKE its parent copies a default
// on every supported version, and what it does with an identity has changed
// between them.
export const EVENTS_SEQUENCE = 'events_seq';
export const AUDIT_SEQUENCE = 'audit_log_seq';

export const sequences: readonly string[] = [EVENTS_SEQUENCE, AUDIT_SEQUENCE];

const TEXT = 'text COLLATE "C"';
const TEXT_ARRAY = 'text[] COLLATE "C"';

function text(name: string, required = false): ColumnSchema {
  return { name, definition: required ? `${TEXT} NOT NULL` : TEXT };
}

function instant(name: string, required = false): ColumnSchema {
  return { name, definition: required ? 'bigint NOT NULL' : 'bigint' };
}

function json(name: string, required = false): ColumnSchema {
  return { name, definition: required ? 'jsonb NOT NULL' : 'jsonb' };
}

function column(name: string, definition: string): ColumnSchema {
  return { name, definition };
}

// A field of a stored document as a column of its own, kept by Postgres from
// the document, so the column a report groups by cannot disagree with the
// document the row carries.
function generated(name: string, document: string, field: string): ColumnSchema {
  return {
    name,
    definition: `${TEXT} GENERATED ALWAYS AS (${document} ->> '${field}') STORED`,
  };
}

// The nested fields a read groups or filters by, on both an event and a stay:
// the campaign, the place and the device. The names match the dimension, not
// the wire: the tracker strips the utm_ prefix before it sends the object.
const SOURCE_COLUMNS: readonly ColumnSchema[] = [
  generated('utm_source', 'utm', 'source'),
  generated('utm_medium', 'utm', 'medium'),
  generated('utm_campaign', 'utm', 'campaign'),
  generated('utm_term', 'utm', 'term'),
  generated('utm_content', 'utm', 'content'),
  generated('country', 'geo', 'country'),
  generated('region', 'geo', 'region'),
  generated('city', 'geo', 'city'),
  generated('browser', 'ua', 'browser'),
  generated('os', 'ua', 'os'),
  generated('device', 'ua', 'device'),
];

// A row of site scoped configuration: who wrote it and when.
const AUTHORED: readonly ColumnSchema[] = [text('created_by', true), instant('created_at', true)];

export const schema: readonly TableSchema[] = [
  {
    name: SITES,
    purpose: 'One row per tracked site: its settings and its public share.',
    columns: [
      text('id', true),
      text('name', true),
      text('team_id'),
      json('settings', true),
      json('share'),
      instant('routes_changed_at'),
    ],
    primaryKey: ['id'],
    indexes: [
      // The public share's token, one site per token. Partial, so the sites
      // with no share are not in it at all.
      {
        name: 'site_share_token',
        definition: `((share ->> 'token')) WHERE (share ->> 'token') IS NOT NULL`,
        unique: true,
      },
    ],
  },
  {
    name: SITE_DOMAINS,
    purpose: 'Which site a domain belongs to. One site per domain, by the key.',
    columns: [
      text('domain', true),
      column('site_id', `${TEXT} NOT NULL REFERENCES ${SITES} (id) ON DELETE CASCADE`),
      // Where the domain sits in the site's own list, which is an order the
      // contract hands back.
      column('position', 'integer NOT NULL'),
    ],
    // A domain belongs to one site, so a key stolen from another page cannot
    // borrow somebody else's numbers. The key is what refuses the second.
    primaryKey: ['domain'],
    indexes: [{ name: 'site_domain_site', definition: '(site_id)' }],
  },
  {
    name: EVENTS,
    purpose: 'Raw events, one partition per month. Aged out by the retention purge.',
    columns: [
      column('seq', `bigint NOT NULL DEFAULT nextval('${EVENTS_SEQUENCE}')`),
      text('site_id', true),
      instant('ts', true),
      instant('received_at', true),
      text('type', true),
      text('visitor_id', true),
      text('session_id'),
      text('user_id'),
      text('path'),
      text('route'),
      text('hostname'),
      text('title'),
      text('referrer'),
      json('utm'),
      json('geo'),
      text('ip'),
      json('ua'),
      text('screen'),
      text('viewport'),
      text('lang'),
      column('bot', 'boolean NOT NULL'),
      text('source'),
      text('name'),
      text('status'),
      json('props'),
      json('traits'),
      column('duration', 'double precision'),
      column('scroll_depth', 'double precision'),
      column('value', 'double precision'),
      text('rating'),
      text('frame'),
      text('stack'),
      ...SOURCE_COLUMNS,
    ],
    partitionBy: 'PARTITION BY RANGE (ts)',
    indexes: [
      { name: 'event_site_ts', definition: '(site_id, ts)' },
      // The health reads walk one type of row over a range: the vitals, which
      // are a share of the events, and the errors, which are a sliver of them.
      { name: 'event_site_type_ts', definition: '(site_id, type, ts)' },
      // A profile reads one visitor's rows, and an identity merge rewrites
      // them; neither should walk a site's whole history to find one person.
      { name: 'event_site_visitor_ts', definition: '(site_id, visitor_id, ts)' },
      // Partial, because most rows belong to nobody an identify has named and
      // the reads that use this (a user's profile, tracker coverage) never ask
      // about them.
      {
        name: 'event_site_user_ts',
        definition: '(site_id, user_id, ts) WHERE user_id IS NOT NULL',
      },
    ],
  },
  {
    name: SESSIONS,
    purpose: 'A visitor stay: one row per unbroken run of their events.',
    columns: [
      text('site_id', true),
      text('id', true),
      text('visitor_id', true),
      text('user_id'),
      instant('started_at', true),
      instant('last_seen_at', true),
      instant('ended_at'),
      text('entry_path'),
      text('exit_path'),
      column('pageviews', 'integer NOT NULL'),
      column('events', 'integer NOT NULL'),
      column('duration', 'bigint NOT NULL'),
      text('referrer'),
      text('channel'),
      json('utm'),
      json('geo'),
      text('ip'),
      json('ua'),
      column('bot', 'boolean NOT NULL'),
      column('is_new', 'boolean NOT NULL'),
      ...SOURCE_COLUMNS,
    ],
    primaryKey: ['site_id', 'id'],
    indexes: [
      // A visit belongs to the day it began on, so every read of the session
      // side cuts by started_at.
      { name: 'session_site_started', definition: '(site_id, started_at)' },
      { name: 'session_site_last_seen', definition: '(site_id, last_seen_at)' },
      // Newest first, because ingest asks this table one question on every
      // batch: which stay is this visitor's latest.
      { name: 'session_site_visitor', definition: '(site_id, visitor_id, started_at DESC)' },
    ],
  },
  {
    name: VISITORS,
    purpose: 'The person behind the sessions: their counts, devices and touches.',
    columns: [
      text('site_id', true),
      text('id', true),
      text('user_id'),
      json('traits'),
      instant('first_seen_at', true),
      instant('last_seen_at', true),
      column('sessions', 'integer NOT NULL'),
      column('pageviews', 'integer NOT NULL'),
      json('home_geo'),
      json('places', true),
      column('devices', `${TEXT_ARRAY} NOT NULL`),
      column('ips', `${TEXT_ARRAY} NOT NULL`),
      json('first_touch'),
      json('last_touch'),
      // The visitor id, the userId and every trait value, lowercased by the
      // adapter. The people search is "contains, whatever its case", and
      // lowercasing in SQL follows the database's locale (ASCII only on a C
      // one), so the adapter does it once on the way in and the answer is the
      // same on every install.
      column('search', `${TEXT_ARRAY} NOT NULL`),
    ],
    primaryKey: ['site_id', 'id'],
    indexes: [
      // The people directory reads a site's visitors newest first, a page at a
      // time, and the id is the tie break that makes the order total. Both in
      // the key, so a page is a walk of this index and never a sort.
      { name: 'visitor_site_last_seen', definition: '(site_id, last_seen_at DESC, id DESC)' },
      // Not unique: two browsers are two visitors, and the same person signing
      // in on both is exactly what a user lookup has to join.
      { name: 'visitor_site_user', definition: '(site_id, user_id) WHERE user_id IS NOT NULL' },
    ],
  },
  {
    name: ROLLUPS_DAILY,
    purpose: 'One row per site, day, dimension and value. Kept forever.',
    columns: [
      text('site_id', true),
      // A day of the site's own calendar, the key the contract files it under.
      column('date', 'date NOT NULL'),
      text('dim', true),
      text('key', true),
      column('visitors', 'bigint NOT NULL'),
      column('pageviews', 'bigint NOT NULL'),
      column('visits', 'bigint NOT NULL'),
      column('bounces', 'bigint NOT NULL'),
      column('duration_sum', 'bigint NOT NULL'),
    ],
    primaryKey: ['site_id', 'date', 'dim', 'key'],
    indexes: [
      // A breakdown over a range reads one dimension across many days, which
      // the key cannot lead with.
      { name: 'rollup_site_dim_date', definition: '(site_id, dim, date)' },
    ],
  },
  {
    name: GOALS,
    purpose: 'A page or an event counted as a success. A question, not a count.',
    columns: [
      text('site_id', true),
      text('id', true),
      text('name', true),
      text('kind', true),
      text('match', true),
      column('value', 'double precision'),
      ...AUTHORED,
    ],
    primaryKey: ['site_id', 'id'],
    indexes: [],
  },
  {
    name: FUNNELS,
    purpose: 'Steps a visitor takes in order, within a window.',
    columns: [
      text('site_id', true),
      text('id', true),
      text('name', true),
      json('steps', true),
      text('funnel_window', true),
      ...AUTHORED,
    ],
    primaryKey: ['site_id', 'id'],
    indexes: [],
  },
  {
    name: SEGMENTS,
    purpose: 'A named, saved filter list.',
    columns: [text('site_id', true), text('id', true), text('name', true), json('filters', true), ...AUTHORED],
    primaryKey: ['site_id', 'id'],
    indexes: [],
  },
  {
    name: ANNOTATIONS,
    purpose: 'A fact somebody stated about the site at an instant.',
    columns: [
      text('site_id', true),
      text('id', true),
      instant('at', true),
      text('kind', true),
      text('note', true),
      text('url'),
      ...AUTHORED,
    ],
    primaryKey: ['site_id', 'id'],
    indexes: [],
  },
  {
    name: ALERTS,
    purpose: 'A question asked of the numbers on a clock. Evaluated by Chokh Pro.',
    columns: [
      text('site_id', true),
      text('id', true),
      text('name', true),
      json('condition', true),
      json('channels', true),
      ...AUTHORED,
      // The episode state as columns, because the claim compares one of them
      // and sets it in the same statement.
      column('firing', 'boolean NOT NULL'),
      instant('since'),
      instant('checked_bucket'),
      json('recent', true),
    ],
    primaryKey: ['site_id', 'id'],
    indexes: [],
  },
  {
    name: DIGESTS,
    purpose: 'A scheduled digest, one per cadence per site. Sent by Chokh Pro.',
    columns: [
      text('site_id', true),
      text('id', true),
      text('cadence', true),
      column('recipients', `${TEXT_ARRAY} NOT NULL`),
      column('hour', 'integer NOT NULL'),
      column('weekday', 'integer'),
      ...AUTHORED,
      // The last period claimed, a column for the reason an alert's bucket is.
      text('last_period'),
      json('last'),
    ],
    primaryKey: ['site_id', 'id'],
    indexes: [],
  },
  {
    name: USERS,
    purpose: 'Dashboard accounts: an address, an argon2id hash and a name.',
    columns: [
      text('id', true),
      // Lowercased by the adapter on the way in, because one address is one
      // address however it was typed and the index would otherwise hold both.
      text('email', true),
      text('name'),
      text('password_hash'),
      instant('created_at', true),
      instant('last_login_at'),
    ],
    primaryKey: ['id'],
    indexes: [{ name: 'user_email', definition: '(email)', unique: true }],
  },
  {
    name: TEAMS,
    purpose: 'Who may read which sites: owner, editor and viewer membership.',
    columns: [text('id', true), text('name', true), json('members', true)],
    primaryKey: ['id'],
    indexes: [
      // "Which teams is this person in" is asked on every dashboard request,
      // so it is a containment lookup on an index rather than a scan of every
      // team.
      { name: 'team_members', definition: 'USING gin (members jsonb_path_ops)' },
    ],
  },
  {
    name: API_KEYS,
    purpose: 'Hashed keys and their scopes. The hash is SHA-256 of the token.',
    columns: [
      // The one read on the authentication path is by this, so it is the key.
      text('key_hash', true),
      text('id', true),
      text('site_id', true),
      text('name', true),
      column('scopes', `${TEXT_ARRAY} NOT NULL`),
      instant('created_at', true),
      text('created_by', true),
    ],
    primaryKey: ['key_hash'],
    indexes: [{ name: 'api_key_site', definition: '(site_id)' }],
  },
  {
    name: AUDIT_LOG,
    purpose: 'Who read an IP or an identified person. Kept forever.',
    columns: [
      // The order two reads of one millisecond were written in.
      column('seq', `bigint NOT NULL DEFAULT nextval('${AUDIT_SEQUENCE}')`),
      text('site_id', true),
      instant('ts', true),
      json('actor', true),
      text('action', true),
      text('route', true),
      text('target'),
      column('fields', `${TEXT_ARRAY} NOT NULL`),
    ],
    primaryKey: ['seq'],
    indexes: [{ name: 'audit_site_ts', definition: '(site_id, ts)' }],
  },
];

export function primaryKeyName(table: TableSchema): string {
  return `${table.name}_pkey`;
}

// Every index a table is declared to have, its primary key's included, by
// name. This is what migrate counts.
export function declaredIndexNames(table: TableSchema): string[] {
  const names = table.indexes.map((index) => index.name);
  return table.primaryKey === undefined ? names : [primaryKeyName(table), ...names];
}

export const DECLARED_INDEX_COUNT = schema.reduce(
  (total, table) => total + declaredIndexNames(table).length,
  0,
);

export function createTableSql(table: TableSchema): string {
  const lines = table.columns.map((each) => `  ${each.name} ${each.definition}`);
  if (table.primaryKey !== undefined) {
    lines.push(
      `  CONSTRAINT ${primaryKeyName(table)} PRIMARY KEY (${table.primaryKey.join(', ')})`,
    );
  }
  const tail = table.partitionBy === undefined ? '' : ` ${table.partitionBy}`;
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${lines.join(',\n')}\n)${tail}`;
}

export function addColumnSql(table: TableSchema, each: ColumnSchema): string {
  return `ALTER TABLE ${table.name} ADD COLUMN IF NOT EXISTS ${each.name} ${each.definition}`;
}

export function createIndexSql(table: TableSchema, index: IndexSchema): string {
  const unique = index.unique === true ? 'UNIQUE ' : '';
  return `CREATE ${unique}INDEX IF NOT EXISTS ${index.name} ON ${table.name} ${index.definition}`;
}
