import pg from 'pg';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

// The adapter's one way to the database: the pool, how a statement is sent,
// and what is done to a value on its way in.

// How many connections one process holds. Ten is the driver's own default and
// is plenty for one collector: an ingest is two statements and a report a
// handful. An install behind a pooler, or on a database with a small
// connection limit, sets it lower.
export const DEFAULT_POOL_SIZE = 10;

// How long one statement may run before the server cancels it. A report that
// has not answered in half a minute is not going to be read, and without a
// limit it holds a connection until it finishes: ten of them and the collector
// has nowhere to write. The jobs that are meant to be long (a rollup, a route
// regroup, the retention purge) lift it for their own transaction.
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export interface PoolOptions {
  url: string;
  poolSize?: number;
  statementTimeoutMs?: number;
  // Told about an error on a connection nobody was using. See openPool.
  onIdleError?: (error: Error) => void;
}

// bigint and numeric arrive as strings by default, because a JavaScript number
// cannot hold every one of them. Ours can: an instant in milliseconds and a
// count of rows are both far inside 2^53. The parser is set on this pool's own
// registry and never on the driver's global one, so an application that embeds
// the adapter beside its own use of pg keeps its own.
function ownTypes(): InstanceType<typeof pg.TypeOverrides> {
  const types = new pg.TypeOverrides();
  types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
  return types;
}

export function openPool(options: PoolOptions): Pool {
  const pool = new pg.Pool({
    // TLS comes from here: sslmode in the URL is read by the driver, so a
    // managed database that requires it needs nothing but its own URL.
    connectionString: options.url,
    max: options.poolSize ?? DEFAULT_POOL_SIZE,
    statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    application_name: 'chokh',
    types: ownTypes(),
  });
  // The server closes connections it is holding when it restarts or fails
  // over, and the pool reports each one that was idle at the time through this
  // event. An 'error' nobody listens for ends the process, which would turn a
  // database restart into a collector restart; the pool has already discarded
  // the connection and opens another when it next needs one, so there is
  // nothing to do here but say so.
  pool.on('error', (error) => {
    options.onIdleError?.(error);
  });
  return pool;
}

// Postgres cannot store a NUL character in text or in jsonb, and refuses JSON
// that carries half of a surrogate pair. MongoDB stores the first and replaces
// the second. Both can arrive in a page title or a property somebody crafted,
// and one of them in one event would otherwise fail the whole batch it came
// in, so they are taken out on the way in: the NUL removed, the broken half
// replaced with the replacement character the other store would have written.
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);
const SURROGATE = /[\uD800-\uDFFF]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function storableText(value: string): string {
  // Almost every string has neither, so the two tests come before any copy.
  const cut = value.includes(NUL) ? value.split(NUL).join('') : value;
  return SURROGATE.test(cut) ? cut.replace(LONE_SURROGATE, REPLACEMENT) : cut;
}

function storable(value: unknown): unknown {
  if (typeof value === 'string') {
    return storableText(value);
  }
  if (Array.isArray(value)) {
    return value.map(storable);
  }
  if (value !== null && typeof value === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, each] of Object.entries(value)) {
      if (each !== undefined) {
        cleaned[storableText(key)] = storable(each);
      }
    }
    return cleaned;
  }
  return value;
}

// A value for a jsonb column. Always a string and always cast in the
// statement: the driver would send a JavaScript array as a Postgres array,
// which is not what a jsonb column holding a list wants.
export function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(storable(value));
}

// A text or text[] parameter, cleaned the same way.
export function text(value: string | undefined | null): string | null {
  return value === undefined || value === null ? null : storableText(value);
}

export function textArray(values: readonly string[]): string[] {
  return values.map(storableText);
}

export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<Row>>;
}

// Run several statements as one transaction on one connection. The connection
// goes back to the pool whatever happens, and anything thrown rolls back.
export async function transaction<Result>(
  pool: Pool,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// The codes this adapter reads off a refused statement.
export const UNIQUE_VIOLATION = '23505';
export const NO_PARTITION = '23514';

export function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
