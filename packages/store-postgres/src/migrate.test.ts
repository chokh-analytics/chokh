import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apply, formatReport, runCli, verify } from './migrate.js';
import { listPartitions, monthAfter, monthOf } from './partitions.js';
import { DECLARED_INDEX_COUNT, schema, sequences } from './schema.js';
import { PostgresSetupError, assertSupported, type ServerInfo } from './server.js';
import { createTestDatabase, databaseUrl, type TestDatabase } from './testing/database.js';

const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const now = (): number => NOW;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('migrate');
});

afterAll(async () => {
  await db.drop();
});

describe('migrate', () => {
  it('reports everything missing before it runs', async () => {
    const before = await verify(db.pool);
    expect(before.presentIndexes).toBe(0);
    expect(before.missingIndexes).toBe(DECLARED_INDEX_COUNT);
    expect(before.missingTables).toBe(schema.length);
    expect(before.missingSequences).toEqual([...sequences]);
    expect(before.missing).toBe(schema.length + DECLARED_INDEX_COUNT + sequences.length);
  });

  it('creates every table and index the schema declares, and two months of events', async () => {
    const applied = await apply(db.pool, { now });
    expect(applied.tablesCreated).toHaveLength(schema.length);
    expect(applied.indexesCreated).toHaveLength(DECLARED_INDEX_COUNT);
    expect(applied.partitionsCreated).toEqual(['events_p202609', 'events_p202610']);
    expect(applied.missing).toBe(0);
    expect(applied.undeclaredIndexes).toBe(0);
  });

  it('reports missing: 0 afterwards, which is what a deployment gates on', async () => {
    const after = await verify(db.pool);
    expect(after.missing).toBe(0);
    expect(after.presentIndexes).toBe(DECLARED_INDEX_COUNT);
    expect(after.server.encoding).toBe('UTF8');
    const text = formatReport(after);
    expect(text).toContain('missing: 0');
    expect(text).toContain(`tables: ${schema.length}, indexes: ${DECLARED_INDEX_COUNT} present of`);
    expect(text).toMatch(/events +indexes 4\/4, partitions 2/);
  });

  it('is safe to run twice', async () => {
    const again = await apply(db.pool, { now });
    expect(again.tablesCreated).toEqual([]);
    expect(again.columnsCreated).toEqual([]);
    expect(again.indexesCreated).toEqual([]);
    expect(again.partitionsCreated).toEqual([]);
    expect(again.missing).toBe(0);
  });

  it('gives the partitions the bounds of their month and the indexes of their parent', async () => {
    const month = monthOf(NOW);
    expect(await listPartitions(db.pool)).toEqual([
      { name: month.name, from: month.from, to: month.to },
      { name: 'events_p202610', from: month.to, to: monthAfter(month).to },
    ]);
    const indexes = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1`,
      [month.name],
    );
    expect(Number(indexes.rows[0]?.n)).toBe(4);
  });

  it('reports an index nobody declared without dropping it', async () => {
    await db.pool.query('CREATE INDEX somebody_added_this ON goals (name)');
    const result = await apply(db.pool, { now });
    expect(result.undeclaredIndexes).toBe(1);
    expect(formatReport(result)).toContain('undeclared: somebody_added_this');
    expect(result.missing).toBe(0);
    const kept = await db.pool.query(`SELECT to_regclass('somebody_added_this') AS found`);
    expect(kept.rows[0]?.found).not.toBeNull();
    await db.pool.query('DROP INDEX somebody_added_this');
  });

  it('puts back a column and an index that are gone, and nothing else', async () => {
    await db.pool.query('ALTER TABLE goals DROP COLUMN value');
    await db.pool.query('DROP INDEX event_site_type_ts');
    const before = await verify(db.pool);
    expect(before.missingColumns).toBe(1);
    expect(before.missingIndexes).toBe(1);
    expect(before.missing).toBe(2);
    expect(formatReport(before)).toContain('columns missing: value');

    const result = await apply(db.pool, { now });
    expect(result.columnsCreated).toEqual(['goals.value']);
    expect(result.indexesCreated).toEqual(['events.event_site_type_ts']);
    expect(result.tablesCreated).toEqual([]);
    expect(result.missing).toBe(0);
  });

  it('counts an index Postgres holds invalid as missing, because no query reads one', async () => {
    // What a CREATE INDEX CONCURRENTLY that failed leaves behind. Marked by
    // hand here, which needs a superuser; both the bundled server and the CI
    // service container run the tests as one.
    const mark = (valid: boolean): Promise<unknown> =>
      db.pool.query(
        `UPDATE pg_index SET indisvalid = $1 WHERE indexrelid = to_regclass('session_site_started')`,
        [valid],
      );
    await mark(false);
    try {
      const result = await verify(db.pool);
      expect(result.missingIndexes).toBe(1);
      expect(formatReport(result)).toMatch(/sessions +indexes 3\/4/);
    } finally {
      await mark(true);
    }
    expect((await verify(db.pool)).missing).toBe(0);
  });
});

describe('an apply that fails', () => {
  it('leaves the database exactly as it found it', async () => {
    const broken = await createTestDatabase('migrate_broken');
    try {
      // A view where a table belongs: CREATE TABLE IF NOT EXISTS passes over
      // it and the index on it cannot be built, well after other tables were.
      await broken.pool.query('CREATE VIEW users AS SELECT 1 AS id, 2 AS email');
      await expect(apply(broken.pool, { now })).rejects.toThrow();
      const left = await broken.pool.query<{ name: string }>(
        `SELECT relname AS name FROM pg_class
          WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
      );
      expect(left.rows.map((row) => row.name)).toEqual(['users']);
    } finally {
      await broken.drop();
    }
  });
});

describe('a server this adapter cannot be right on', () => {
  const info = (over: Partial<ServerInfo>): ServerInfo => ({
    version: '17.11',
    versionNum: 170011,
    encoding: 'UTF8',
    database: 'chokh',
    schema: 'public',
    ...over,
  });

  it('accepts the floor and refuses the version below it', () => {
    expect(() => assertSupported(info({ version: '15.0', versionNum: 150000 }))).not.toThrow();
    expect(() => assertSupported(info({ version: '14.19', versionNum: 140019 }))).toThrow(
      /needs PostgreSQL 15 or newer, and this server is 14\.19/,
    );
  });

  it('refuses a database that is not UTF8 before it creates anything in it', async () => {
    const name = `chokh_latin1_${Date.now()}`;
    const admin = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
    await admin.query(
      `CREATE DATABASE ${name} ENCODING 'LATIN1' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    const url = new URL(databaseUrl());
    url.pathname = `/${name}`;
    const latin = new pg.Pool({ connectionString: url.toString(), max: 1 });
    try {
      const refused = await apply(latin, { now }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PostgresSetupError);
      expect((refused as PostgresSetupError).code).toBe('UNSUPPORTED_ENCODING');
      expect((refused as PostgresSetupError).message).toContain('is LATIN1');
      const tables = await latin.query(
        `SELECT 1 FROM pg_class WHERE relkind IN ('r', 'p') AND relnamespace = 'public'::regnamespace`,
      );
      expect(tables.rowCount).toBe(0);

      // The command says the same thing and exits 1, verifying or applying.
      for (const flag of ['--apply', '--verify-only']) {
        const lines: string[] = [];
        const code = await runCli([flag, '--url', url.toString()], (line) => lines.push(line));
        expect(code).toBe(1);
        expect(lines.join('')).toContain('needs a UTF8 database');
      }
    } finally {
      await latin.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  });
});

describe('the migrate command line', () => {
  it('verifies green and exits zero', async () => {
    const lines: string[] = [];
    const code = await runCli(['--verify-only', '--url', db.url], (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines.join('')).toContain('missing: 0');
    expect(lines.join('')).toMatch(/^chokh migrate: \S+ \(schema t_migrate_\w+\), PostgreSQL \d+/);
  });

  it('exits 1 when an index is missing, so a deployment can gate on it', async () => {
    await db.pool.query('DROP INDEX rollup_site_dim_date');
    const lines: string[] = [];
    const code = await runCli(['--verify-only', '--url', db.url], (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines.join('')).toContain('missing: 1');

    const applied: string[] = [];
    expect(await runCli(['--apply', '--url', db.url], (line) => applied.push(line))).toBe(0);
    expect(applied.join('')).toContain('indexes created: rollups_daily.rollup_site_dim_date');
  });

  it('prints the usage when neither flag is given, or both', async () => {
    for (const argv of [[], ['--apply', '--verify-only']]) {
      const lines: string[] = [];
      expect(await runCli(argv, (line) => lines.push(line))).toBe(2);
      expect(lines.join('')).toContain('migrate --apply');
    }
  });
});
