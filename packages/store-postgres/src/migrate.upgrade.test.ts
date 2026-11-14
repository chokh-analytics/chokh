import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apply, formatReport, runCli, verify } from './migrate.js';
import { createPostgresStore } from './postgres.store.js';
import { PostgresSetupError } from './server.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';

// The migration on a database that an earlier release made (AN-TEAM01): three
// tables it has never seen, two columns, and the first time migrate changes
// something that exists, a NOT NULL taken off a column.

const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);
const now = (): number => NOW;

// Take a fully migrated schema back to what the release before this ticket
// declared: no access tables, no session counter, and an audit log whose rows
// are all about a site because the column says they must be.
async function asBefore(db: TestDatabase): Promise<void> {
  await db.pool.query('DROP TABLE site_members, invitations, identities');
  await db.pool.query('ALTER TABLE users DROP COLUMN session_epoch');
  await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT audit_scope');
  // Dropping the column drops the index on it.
  await db.pool.query('ALTER TABLE audit_log DROP COLUMN team_id');
  await db.pool.query('DROP INDEX audit_site_page');
  await db.pool.query('ALTER TABLE audit_log ALTER COLUMN site_id SET NOT NULL');
}

describe('migrating a database from before access existed', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('upgrade');
    await apply(db.pool, { now });
    await asBefore(db);
    // What such an install holds: an account and a row of the log.
    await db.pool.query(
      `INSERT INTO users (id, email, password_hash, created_at) VALUES ('u_1', 'one@example.com', 'h', $1)`,
      [NOW],
    );
    await db.pool.query(
      `INSERT INTO audit_log (site_id, ts, actor, action, route, target, fields)
       VALUES ('s_one', $1, '{"kind":"session","id":"u_1"}'::jsonb, 'read:identity', 'GET /x', 'ada', ARRAY['ip'])`,
      [NOW],
    );
  });

  afterAll(async () => {
    await db.drop();
  });

  it('counts what is owed, the relaxed column and the check among it', async () => {
    const before = await verify(db.pool);
    expect(before.missingTables).toBe(3);
    expect(before.missingColumns).toBe(2);
    expect(before.strictColumns).toBe(1);
    expect(before.missingChecks).toBe(1);
    // The two page indexes of the log; a missing table's own are counted too.
    const log = before.tables.find((row) => row.table === 'audit_log');
    expect(log?.missing).toEqual(['audit_site_page', 'audit_team_page']);
    expect(log?.strictColumns).toEqual(['site_id']);
    expect(log?.missingChecks).toEqual(['audit_scope']);
    expect(before.missing).toBeGreaterThan(0);
    const text = formatReport(before);
    expect(text).toContain('columns missing: team_id');
    expect(text).toContain('columns still NOT NULL: site_id');
    expect(text).toContain('checks missing: audit_scope');

    const lines: string[] = [];
    expect(await runCli(['--verify-only', '--url', db.url], (line) => lines.push(line))).toBe(1);
  });

  it('is refused by the adapter until the migration has run', async () => {
    const refused = await createPostgresStore({ url: db.url }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PostgresSetupError);
    expect((refused as PostgresSetupError).code).toBe('NOT_MIGRATED');
  });

  it('creates what is new, relaxes the one column, and says so', async () => {
    const applied = await apply(db.pool, { now });
    expect(applied.tablesCreated).toEqual(['site_members', 'invitations', 'identities']);
    expect([...applied.columnsCreated].sort()).toEqual(['audit_log.team_id', 'users.session_epoch']);
    expect(applied.columnsRelaxed).toEqual(['audit_log.site_id']);
    expect(applied.checksCreated).toEqual(['audit_log.audit_scope']);
    expect(applied.indexesCreated).toContain('audit_log.audit_site_page');
    expect(applied.indexesCreated).toContain('audit_log.audit_team_page');
    expect(applied.missing).toBe(0);
    expect(applied.undeclaredIndexes).toBe(0);
    const text = formatReport(applied);
    expect(text).toContain('columns relaxed: audit_log.site_id');
    expect(text).toContain('checks created: audit_log.audit_scope');
  });

  it('kept every row that was there, and the adapter now opens and reads them', async () => {
    const store = await createPostgresStore({ url: db.url, now });
    try {
      const user = await store.userById('u_1');
      expect(user?.email).toBe('one@example.com');
      expect(user?.sessionEpoch).toBeUndefined();
      expect(await store.bumpSessionEpoch('u_1')).toBe(1);
      const page = await store.auditPage({ scope: { kind: 'site', id: 's_one' }, limit: 5 });
      expect(page.rows.map((row) => row.target)).toEqual(['ada']);
      // And the table now takes a row about a team.
      await store.audit({
        teamId: 'default',
        ts: NOW,
        actor: { kind: 'session', id: 'u_1' },
        action: 'member:set',
        route: 'PUT /y',
        fields: ['role=viewer'],
      });
      expect(
        (await store.auditPage({ scope: { kind: 'team', id: 'default' }, limit: 5 })).rows,
      ).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('does nothing the second time', async () => {
    const again = await apply(db.pool, { now });
    expect(again.tablesCreated).toEqual([]);
    expect(again.columnsCreated).toEqual([]);
    expect(again.columnsRelaxed).toEqual([]);
    expect(again.checksCreated).toEqual([]);
    expect(again.indexesCreated).toEqual([]);
    expect(again.missing).toBe(0);
  });
});

describe('a migration that a stored row will not let finish', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('upgrade_fail');
    await apply(db.pool, { now });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('keeps nothing of itself when a row breaks the rule it is adding', async () => {
    // A row the rule forbids, in a table that has lost the rule, beside two
    // other things for the migration to put back first.
    await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT audit_scope');
    await db.pool.query(
      `INSERT INTO audit_log (ts, actor, action, route, fields)
       VALUES ($1, '{"kind":"key","id":"k"}'::jsonb, 'x', 'GET /x', ARRAY[]::text[])`,
      [NOW],
    );
    await db.pool.query('ALTER TABLE users DROP COLUMN session_epoch');
    await db.pool.query('DROP TABLE identities');

    const failed = await apply(db.pool, { now }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as { code?: string }).code).toBe('23514');

    // One transaction: the table and the column it had already made on the
    // way to the rule are not there either.
    const after = await verify(db.pool);
    expect(after.missingTables).toBe(1);
    expect(after.missingColumns).toBe(1);
    expect(after.missingChecks).toBe(1);

    // With the row put right it goes through.
    await db.pool.query(`UPDATE audit_log SET site_id = 's_fixed' WHERE site_id IS NULL AND team_id IS NULL`);
    const applied = await apply(db.pool, { now });
    expect(applied.missing).toBe(0);
    expect(applied.checksCreated).toEqual(['audit_log.audit_scope']);
  });
});
