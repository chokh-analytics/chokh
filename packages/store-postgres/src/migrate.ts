#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

import { readEnv } from './env.js';
import { advisoryLockSql, LOCK_MIGRATE } from './locks.js';
import { createPartition, listPartitions, monthAfter, monthOf } from './partitions.js';
import {
  EVENTS,
  addColumnSql,
  createIndexSql,
  createTableSql,
  declaredIndexNames,
  primaryKeyName,
  schema,
  sequences,
  type TableSchema,
} from './schema.js';
import { PostgresSetupError, assertSupported, inspectServer, type ServerInfo } from './server.js';

// The only code in Chokh that creates a table or an index in PostgreSQL. Run
// it once before the collector writes anything, and again after every upgrade:
//
//   node packages/store-postgres/dist/migrate.js --apply
//   node packages/store-postgres/dist/migrate.js --verify-only
//
// --verify-only exits 1 when anything is missing, so a deployment can gate on
// it. An index nobody declared is reported and never dropped: it may be one a
// person added on purpose, and a migration is not the place to lose it.
//
// --apply is one transaction. DDL is transactional here, so an apply that
// fails halfway leaves the database exactly as it found it, and two of them
// started at once take turns on an advisory lock.

export interface TableReport {
  table: string;
  exists: boolean;
  missingColumns: string[];
  declared: number;
  present: string[];
  missing: string[];
  undeclared: string[];
  // Only on events: how many months it has a partition for.
  partitions?: number;
}

export interface MigrateReport {
  server: ServerInfo;
  tables: TableReport[];
  missingSequences: string[];
  tablesCreated: string[];
  columnsCreated: string[];
  indexesCreated: string[];
  partitionsCreated: string[];
  declaredIndexes: number;
  presentIndexes: number;
  missingTables: number;
  missingColumns: number;
  missingIndexes: number;
  undeclaredIndexes: number;
  // Everything a deployment has to wait for: tables, columns, sequences and
  // indexes together. Zero is the only number --verify-only accepts.
  missing: number;
}

interface Created {
  tables: string[];
  columns: string[];
  indexes: string[];
  partitions: string[];
}

interface Queryable {
  query: PoolClient['query'];
}

// Scoped to the schema the connection is in, so a table of the same name in
// another schema of the database is not mistaken for ours.
const IN_THIS_SCHEMA = `relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`;

async function inspect(db: Queryable, table: TableSchema): Promise<TableReport> {
  const declared = declaredIndexNames(table);
  const found = await db.query<{ oid: number }>(
    `SELECT oid FROM pg_class WHERE relname = $1 AND relkind IN ('r', 'p') AND ${IN_THIS_SCHEMA}`,
    [table.name],
  );
  const oid = found.rows[0]?.oid;
  if (oid === undefined) {
    // A table nobody has created does not exist yet, which is not an error: it
    // is exactly what --apply is for.
    return {
      table: table.name,
      exists: false,
      missingColumns: table.columns.map((each) => each.name),
      declared: declared.length,
      present: [],
      missing: declared,
      undeclared: [],
    };
  }
  const columns = await db.query<{ name: string }>(
    `SELECT attname AS name FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`,
    [oid],
  );
  const have = new Set(columns.rows.map((row) => row.name));
  // An index a failed CREATE INDEX CONCURRENTLY left behind is there and
  // useless: Postgres keeps it invalid and never reads it. It counts as
  // missing, which is what it is to every query.
  const indexes = await db.query<{ name: string; valid: boolean }>(
    `SELECT index.relname AS name, pg_index.indisvalid AS valid
       FROM pg_index JOIN pg_class index ON index.oid = pg_index.indexrelid
      WHERE pg_index.indrelid = $1`,
    [oid],
  );
  const usable = indexes.rows.filter((row) => row.valid).map((row) => row.name);
  const existing = indexes.rows.map((row) => row.name);
  const report: TableReport = {
    table: table.name,
    exists: true,
    missingColumns: table.columns.map((each) => each.name).filter((name) => !have.has(name)),
    declared: declared.length,
    present: declared.filter((name) => usable.includes(name)),
    missing: declared.filter((name) => !usable.includes(name)),
    undeclared: existing.filter((name) => !declared.includes(name)),
  };
  if (table.name === EVENTS) {
    report.partitions = (await listPartitions(db)).length;
  }
  return report;
}

async function missingSequences(db: Queryable): Promise<string[]> {
  const found = await db.query<{ name: string }>(
    `SELECT relname AS name FROM pg_class WHERE relkind = 'S' AND relname = ANY($1) AND ${IN_THIS_SCHEMA}`,
    [[...sequences]],
  );
  const have = new Set(found.rows.map((row) => row.name));
  return sequences.filter((name) => !have.has(name));
}

async function report(db: Queryable, server: ServerInfo, created: Created): Promise<MigrateReport> {
  const tables: TableReport[] = [];
  for (const table of schema) {
    tables.push(await inspect(db, table));
  }
  const sequencesMissing = await missingSequences(db);
  const count = (pick: (row: TableReport) => number): number =>
    tables.reduce((total, row) => total + pick(row), 0);
  const missingTables = count((row) => (row.exists ? 0 : 1));
  // A missing table's columns are not counted again: creating it is one act.
  const missingColumns = count((row) => (row.exists ? row.missingColumns.length : 0));
  const missingIndexes = count((row) => row.missing.length);
  return {
    server,
    tables,
    missingSequences: sequencesMissing,
    tablesCreated: created.tables,
    columnsCreated: created.columns,
    indexesCreated: created.indexes,
    partitionsCreated: created.partitions,
    declaredIndexes: count((row) => row.declared),
    presentIndexes: count((row) => row.present.length),
    missingTables,
    missingColumns,
    missingIndexes,
    undeclaredIndexes: count((row) => row.undeclared.length),
    missing: missingTables + missingColumns + missingIndexes + sequencesMissing.length,
  };
}

export async function verify(pool: Pool): Promise<MigrateReport> {
  const server = await inspectServer(pool);
  return report(pool, server, { tables: [], columns: [], indexes: [], partitions: [] });
}

export interface ApplyOptions {
  // Injected so a test can say which month is the current one.
  now?: () => number;
}

export async function apply(pool: Pool, options: ApplyOptions = {}): Promise<MigrateReport> {
  const now = options.now ?? ((): number => Date.now());
  const created: Created = { tables: [], columns: [], indexes: [], partitions: [] };
  const client = await pool.connect();
  try {
    const server = await inspectServer(client);
    // Before anything is created: a database this adapter cannot be right on
    // should be told so while it is still empty.
    assertSupported(server);
    await client.query('BEGIN');
    await client.query(advisoryLockSql(LOCK_MIGRATE));

    for (const name of sequences) {
      await client.query(`CREATE SEQUENCE IF NOT EXISTS ${name}`);
    }
    for (const table of schema) {
      const before = await inspect(client, table);
      if (!before.exists) {
        await client.query(createTableSql(table));
        created.tables.push(table.name);
        if (table.primaryKey !== undefined) {
          created.indexes.push(`${table.name}.${primaryKeyName(table)}`);
        }
      } else {
        // A column a later release declared. Additive only: nothing here ever
        // drops or retypes one.
        for (const each of table.columns) {
          if (before.missingColumns.includes(each.name)) {
            await client.query(addColumnSql(table, each));
            created.columns.push(`${table.name}.${each.name}`);
          }
        }
      }
      for (const index of table.indexes) {
        if (before.missing.includes(index.name)) {
          await client.query(createIndexSql(table, index));
          created.indexes.push(`${table.name}.${index.name}`);
        }
      }
    }
    // This month and the next, so the first batch after an install and the
    // first batch of next month find their partition waiting. Any other month
    // is made by ingest when a batch needs it.
    const current = monthOf(now());
    for (const month of [current, monthAfter(current)]) {
      if (await createPartition(client, month)) {
        created.partitions.push(month.name);
      }
    }
    await client.query('COMMIT');
    return await report(client, server, created);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function formatReport(result: MigrateReport): string {
  const { server } = result;
  const lines = [
    `chokh migrate: ${server.database} (schema ${server.schema}), PostgreSQL ${server.version}, ${server.encoding}`,
  ];
  for (const row of result.tables) {
    const notes: string[] = [];
    if (!row.exists) notes.push('table missing');
    if (row.exists && row.missingColumns.length > 0) {
      notes.push(`columns missing: ${row.missingColumns.join(', ')}`);
    }
    if (row.partitions !== undefined) notes.push(`partitions ${row.partitions}`);
    if (row.undeclared.length > 0) notes.push(`undeclared: ${row.undeclared.join(', ')}`);
    const note = notes.length === 0 ? '' : `, ${notes.join(', ')}`;
    lines.push(`  ${row.table.padEnd(14)} indexes ${row.present.length}/${row.declared}${note}`);
  }
  if (result.missingSequences.length > 0) {
    lines.push(`sequences missing: ${result.missingSequences.join(', ')}`);
  }
  if (result.tablesCreated.length > 0) {
    lines.push(`tables created: ${result.tablesCreated.join(', ')}`);
  }
  if (result.columnsCreated.length > 0) {
    lines.push(`columns created: ${result.columnsCreated.join(', ')}`);
  }
  if (result.indexesCreated.length > 0) {
    lines.push(`indexes created: ${result.indexesCreated.join(', ')}`);
  }
  if (result.partitionsCreated.length > 0) {
    lines.push(`partitions created: ${result.partitionsCreated.join(', ')}`);
  }
  lines.push(
    `tables: ${result.tables.length}, ` +
      `indexes: ${result.presentIndexes} present of ${result.declaredIndexes}, ` +
      `missing: ${result.missing}, unexpected: ${result.undeclaredIndexes}`,
  );
  return lines.join('\n');
}

const USAGE = `chokh migrate: create the tables and indexes Chokh declares in PostgreSQL.

  migrate --apply         create anything missing, then report
  migrate --verify-only   report only, exit 1 if anything is missing

The database comes from DATABASE_URL, or from --url <connection string>.
`;

function argValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

export async function runCli(argv: string[], write: (line: string) => void): Promise<number> {
  const wantsApply = argv.includes('--apply');
  const wantsVerify = argv.includes('--verify-only');
  if (wantsApply === wantsVerify) {
    write(USAGE);
    return 2;
  }
  const url = argValue(argv, '--url') ?? readEnv().DATABASE_URL;
  if (url === undefined || url === '') {
    write('No database: set DATABASE_URL or pass --url.\n');
    return 2;
  }

  // One connection: a migration is one transaction and has nothing to do in
  // parallel.
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const result = wantsApply ? await apply(pool) : await verify(pool);
    write(`${formatReport(result)}\n`);
    try {
      // --verify-only reports before it judges, so the line that says why is
      // under the table that shows what is there.
      assertSupported(result.server);
    } catch (error) {
      if (error instanceof PostgresSetupError) {
        write(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
    return result.missing === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof PostgresSetupError) {
      write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

// Only when run as a command, so importing this file from a test costs nothing.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2), (line) => process.stdout.write(line));
}
