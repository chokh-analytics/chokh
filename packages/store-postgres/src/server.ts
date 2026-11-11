import type { PoolClient } from 'pg';

// What this adapter needs of the server it is pointed at, checked in one place
// by the two things that open a database: migrate and the adapter itself.

// PostgreSQL 15, as server_version_num spells it. The oldest major still
// supported when this adapter was written, and the one CI proves beside the
// compose default.
export const MIN_SERVER_VERSION_NUM = 150000;
export const MIN_SERVER_VERSION = '15';

export type SetupErrorCode = 'UNSUPPORTED_SERVER' | 'UNSUPPORTED_ENCODING' | 'NOT_MIGRATED';

// Something about the database itself is wrong, as opposed to a query: the
// person to fix it is whoever runs the install, and the message is for them.
export class PostgresSetupError extends Error {
  readonly code: SetupErrorCode;

  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.name = 'PostgresSetupError';
    this.code = code;
  }
}

export interface ServerInfo {
  // As the server spells it: 17.11
  version: string;
  versionNum: number;
  encoding: string;
  database: string;
  schema: string;
}

interface Queryable {
  query: PoolClient['query'];
}

export async function inspectServer(db: Queryable): Promise<ServerInfo> {
  const result = await db.query<{
    version: string;
    num: string;
    encoding: string;
    database: string;
    schema: string | null;
  }>(
    `SELECT current_setting('server_version') AS version,
            current_setting('server_version_num') AS num,
            current_setting('server_encoding') AS encoding,
            current_database() AS database,
            current_schema() AS schema`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('The server answered nothing about itself');
  }
  return {
    // "17.11 (Debian 17.11-1.pgdg120+1)" on a packaged build: the number only.
    version: row.version.split(' ')[0] ?? row.version,
    versionNum: Number(row.num),
    encoding: row.encoding,
    database: row.database,
    schema: row.schema ?? '',
  };
}

// Refuse a server this adapter cannot be right on.
//
// The encoding is not a formality. A database created on a Windows machine
// without being told otherwise takes the machine's code page (WIN1252 on an
// English one), and it then refuses any text outside that page: a Bangla page
// title fails the whole batch it arrived in. Every official image and every
// managed service creates UTF8, so this only ever stops a hand-made database,
// and it stops it at the first command rather than at the first visitor from
// somewhere else.
export function assertSupported(info: ServerInfo): void {
  if (info.versionNum < MIN_SERVER_VERSION_NUM) {
    throw new PostgresSetupError(
      'UNSUPPORTED_SERVER',
      `Chokh needs PostgreSQL ${MIN_SERVER_VERSION} or newer, and this server is ${info.version}`,
    );
  }
  if (info.encoding !== 'UTF8') {
    throw new PostgresSetupError(
      'UNSUPPORTED_ENCODING',
      `Chokh needs a UTF8 database, and "${info.database}" is ${info.encoding}. Create it again with ENCODING 'UTF8' (createdb -E UTF8, or initdb --encoding=UTF8)`,
    );
  }
}
