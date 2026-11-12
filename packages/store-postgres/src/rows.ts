import type {
  Attributes,
  StoredEvent,
  StoredSession,
  StoredVisitor,
} from '@chokh/store';

import { storableText } from './db.js';
import { EVENTS, SESSIONS, VISITORS } from './schema.js';

// How the three rows ingest writes cross between the contract's shape and this
// schema's columns. Each table is described once, a column at a time: where it
// sits, the type a batch is read into, how it is taken off the contract's
// object and how it is put back. The insert, the upsert and the two mappers
// are all drawn from that one list, so a column cannot be written and not
// read, or read under another name.

interface Field<Shape> {
  column: string;
  // The type the column is read into when a batch arrives as JSON.
  type: string;
  write(row: Shape): unknown;
  read(value: unknown, into: Shape): void;
}

type Row = Record<string, unknown>;

// A plain column: the same value both ways, absent on the object when null in
// the table. `key` is the contract's field.
function plain<Shape>(column: string, type: string, key: keyof Shape & string): Field<Shape> {
  return {
    column,
    type,
    write: (row) => row[key] ?? null,
    read: (value, into) => {
      if (value !== null && value !== undefined) {
        (into as Record<string, unknown>)[key] = value;
      }
    },
  };
}

const TEXT = 'text';
const INSTANT = 'bigint';
const JSONB = 'jsonb';

const EVENT_FIELDS: readonly Field<StoredEvent>[] = [
  plain('site_id', TEXT, 'siteId'),
  plain('ts', INSTANT, 'ts'),
  plain('received_at', INSTANT, 'receivedAt'),
  plain('type', TEXT, 'type'),
  plain('visitor_id', TEXT, 'visitorId'),
  plain('session_id', TEXT, 'sessionId'),
  plain('user_id', TEXT, 'userId'),
  plain('path', TEXT, 'path'),
  plain('route', TEXT, 'route'),
  plain('hostname', TEXT, 'hostname'),
  plain('title', TEXT, 'title'),
  plain('referrer', TEXT, 'referrer'),
  plain('utm', JSONB, 'utm'),
  plain('geo', JSONB, 'geo'),
  plain('ip', TEXT, 'ip'),
  plain('ua', JSONB, 'ua'),
  plain('screen', TEXT, 'screen'),
  plain('viewport', TEXT, 'viewport'),
  plain('lang', TEXT, 'lang'),
  plain('bot', 'boolean', 'bot'),
  plain('source', TEXT, 'source'),
  plain('name', TEXT, 'name'),
  plain('status', TEXT, 'status'),
  plain('props', JSONB, 'props'),
  plain('traits', JSONB, 'traits'),
  plain('duration', 'double precision', 'duration'),
  plain('scroll_depth', 'double precision', 'scrollDepth'),
  plain('value', 'double precision', 'value'),
  plain('rating', TEXT, 'rating'),
  plain('frame', TEXT, 'frame'),
  plain('stack', TEXT, 'stack'),
];

const SESSION_FIELDS: readonly Field<StoredSession>[] = [
  plain('site_id', TEXT, 'siteId'),
  plain('id', TEXT, 'id'),
  plain('visitor_id', TEXT, 'visitorId'),
  plain('user_id', TEXT, 'userId'),
  plain('started_at', INSTANT, 'startedAt'),
  plain('last_seen_at', INSTANT, 'lastSeenAt'),
  plain('ended_at', INSTANT, 'endedAt'),
  plain('entry_path', TEXT, 'entryPath'),
  plain('exit_path', TEXT, 'exitPath'),
  plain('pageviews', 'integer', 'pageviews'),
  plain('events', 'integer', 'events'),
  plain('duration', INSTANT, 'duration'),
  plain('referrer', TEXT, 'referrer'),
  plain('channel', TEXT, 'channel'),
  plain('utm', JSONB, 'utm'),
  plain('geo', JSONB, 'geo'),
  plain('ip', TEXT, 'ip'),
  plain('ua', JSONB, 'ua'),
  plain('bot', 'boolean', 'bot'),
  plain('is_new', 'boolean', 'isNew'),
];

// What the people search looks through, lowercased here and not in SQL. The
// search is "contains, whatever its case", and lower() in the database follows
// its locale (ASCII only on a C one), so the adapter does it once on the way
// in, with the same function the shared matcher uses, and the answer is the
// same on every install.
export function searchTerms(visitor: {
  id: string;
  userId?: string;
  traits?: Attributes;
}): string[] {
  const terms = [visitor.id];
  if (visitor.userId !== undefined) terms.push(visitor.userId);
  terms.push(...Object.values(visitor.traits ?? {}));
  return terms.map((term) => storableText(String(term)).toLowerCase());
}

const VISITOR_FIELDS: readonly Field<StoredVisitor>[] = [
  plain('site_id', TEXT, 'siteId'),
  plain('id', TEXT, 'id'),
  plain('user_id', TEXT, 'userId'),
  plain('traits', JSONB, 'traits'),
  plain('first_seen_at', INSTANT, 'firstSeenAt'),
  plain('last_seen_at', INSTANT, 'lastSeenAt'),
  plain('sessions', 'integer', 'sessions'),
  plain('pageviews', 'integer', 'pageviews'),
  plain('home_geo', JSONB, 'homeGeo'),
  plain('places', JSONB, 'places'),
  // Lists of text, which travel inside the batch as JSON arrays and are turned
  // into text[] by the statement.
  plain('devices', JSONB, 'devices'),
  plain('ips', JSONB, 'ips'),
  plain('first_touch', JSONB, 'firstTouch'),
  plain('last_touch', JSONB, 'lastTouch'),
  {
    column: 'search',
    type: JSONB,
    write: (row) => searchTerms(row),
    // Derived from the row; nothing on the contract's object holds it.
    read: () => undefined,
  },
];

// The columns of visitors that are text[] in the table.
const TEXT_ARRAYS = new Set(['devices', 'ips', 'search']);

function toRecord<Shape>(fields: readonly Field<Shape>[], row: Shape): Row {
  const record: Row = {};
  for (const field of fields) {
    record[field.column] = field.write(row);
  }
  return record;
}

function fromRecord<Shape>(fields: readonly Field<Shape>[], record: Row): Shape {
  const row = {} as Shape;
  for (const field of fields) {
    field.read(record[field.column], row);
  }
  return row;
}

export const eventRecord = (event: StoredEvent): Row => toRecord(EVENT_FIELDS, event);
export const sessionRecord = (session: StoredSession): Row => toRecord(SESSION_FIELDS, session);
export const visitorRecord = (visitor: StoredVisitor): Row => toRecord(VISITOR_FIELDS, visitor);

export const eventOf = (record: Row): StoredEvent => fromRecord(EVENT_FIELDS, record);
export const sessionOf = (record: Row): StoredSession => fromRecord(SESSION_FIELDS, record);
export const visitorOf = (record: Row): StoredVisitor => fromRecord(VISITOR_FIELDS, record);

function columnsOf<Shape>(fields: readonly Field<Shape>[], alias?: string): string {
  return fields
    .map((field) => (alias === undefined ? field.column : `${alias}.${field.column}`))
    .join(', ');
}

// Every column of a row as the contract reads it back, for a SELECT.
export const EVENT_COLUMNS = columnsOf(EVENT_FIELDS, 'e');
export const VISITOR_COLUMNS = columnsOf(
  VISITOR_FIELDS.filter((field) => field.column !== 'search'),
  'v',
);

// A batch as one jsonb parameter, read back into typed rows in the order it
// was sent: `param` is the placeholder holding a JSON array of records.
function batchSource<Shape>(fields: readonly Field<Shape>[], param: string): string {
  const types = fields.map((field) => `${field.column} ${field.type}`).join(', ');
  return `jsonb_array_elements(${param}::jsonb) WITH ORDINALITY AS batch(item, ord)
         CROSS JOIN LATERAL jsonb_to_record(batch.item) AS given(${types})`;
}

function batchValues<Shape>(fields: readonly Field<Shape>[]): string {
  return fields
    .map((field) =>
      TEXT_ARRAYS.has(field.column)
        ? `ARRAY(SELECT jsonb_array_elements_text(given.${field.column}))`
        : `given.${field.column}`,
    )
    .join(', ');
}

// Rows inserted in the order of the batch, so the sequence that orders two
// events of one millisecond follows the order they were sent in.
export function insertEventsSql(param: string): string {
  return `INSERT INTO ${EVENTS} (${columnsOf(EVENT_FIELDS)})
       SELECT ${batchValues(EVENT_FIELDS)}
         FROM ${batchSource(EVENT_FIELDS, param)}
        ORDER BY batch.ord`;
}

// Written whole: the fold hands over the row as it now is, so every column is
// replaced, the ones that went back to nothing included.
function upsertSql<Shape>(table: string, fields: readonly Field<Shape>[], param: string): string {
  const replaced = fields
    .filter((field) => field.column !== 'site_id' && field.column !== 'id')
    .map((field) => `${field.column} = EXCLUDED.${field.column}`)
    .join(', ');
  return `INSERT INTO ${table} (${columnsOf(fields)})
       SELECT ${batchValues(fields)}
         FROM ${batchSource(fields, param)}
       ON CONFLICT (site_id, id) DO UPDATE SET ${replaced}`;
}

export const upsertSessionsSql = (param: string): string =>
  upsertSql(SESSIONS, SESSION_FIELDS, param);
export const upsertVisitorsSql = (param: string): string =>
  upsertSql(VISITORS, VISITOR_FIELDS, param);
