import type { AuditPageQuery } from '@chokh/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auditPageSql } from './access.js';
import { isCode } from './db.js';
import { apply } from './migrate.js';
import { createPostgresStore, type PostgresStore } from './postgres.store.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';

// What the conformance suite cannot see about access on PostgreSQL: that a
// page of the log is a walk of an index from the cursor, that the database
// itself holds a row of the log to one site or one team, and what an image
// from before this ticket does against the table as it now is.

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

let db: TestDatabase;
let store: PostgresStore;

beforeAll(async () => {
  db = await createTestDatabase('access');
  await apply(db.pool, { now: () => NOW });
  store = await createPostgresStore({ url: db.url, now: () => NOW });
  // Three sites' rows and one team's, four rows to a millisecond, written in
  // time order as a log is, then analysed so the planner knows what it holds.
  await db.pool.query(
    `INSERT INTO audit_log (site_id, ts, actor, action, route, target, fields)
     SELECT 's_' || (n % 3), $1::bigint + n / 4, '{"kind":"session","id":"u_1"}'::jsonb,
            CASE WHEN n % 10 = 0 THEN 'member:set' ELSE 'read:identity' END,
            'GET /x', 't' || n, ARRAY['ip']
       FROM generate_series(0, 8999) AS n`,
    [NOW],
  );
  await db.pool.query(
    `INSERT INTO audit_log (team_id, ts, actor, action, route, target, fields)
     SELECT 't_1', $1::bigint + n, '{"kind":"session","id":"u_1"}'::jsonb, 'member:set',
            'PUT /y', 'u_' || n, ARRAY['role=viewer']
       FROM generate_series(0, 299) AS n`,
    [NOW],
  );
  await db.pool.query('ANALYZE audit_log');
});

afterAll(async () => {
  await store.close();
  await db.drop();
});

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Scan Direction'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode, into: PlanNode[] = []): PlanNode[] {
  into.push(node);
  for (const child of node.Plans ?? []) nodesOf(child, into);
  return into;
}

// The plan Postgres makes for the very statement the adapter runs, with these
// very parameters and no planner setting changed.
async function planOf(query: AuditPageQuery): Promise<PlanNode[]> {
  const { sql, params } = auditPageSql(query);
  const result = await db.pool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    params,
  );
  const plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
  return plan === undefined ? [] : nodesOf(plan);
}

function expectWalk(nodes: PlanNode[], index: string): PlanNode {
  const kinds = nodes.map((node) => node['Node Type']);
  // No sort of any kind: the order comes off the index. And nothing reads the
  // table from its start.
  expect(kinds.filter((kind) => kind.includes('Sort'))).toEqual([]);
  expect(kinds).not.toContain('Seq Scan');
  const scans = nodes.filter((node) => node['Index Name'] !== undefined);
  expect(scans.map((node) => node['Index Name'])).toEqual([index]);
  const scan = scans[0];
  expect(scan?.['Scan Direction']).toBe('Backward');
  return scan as PlanNode;
}

describe('a page of the audit log on PostgreSQL', () => {
  const site = { kind: 'site', id: 's_1' } as const;

  it("walks the page index backwards for a site's first page", async () => {
    expectWalk(await planOf({ scope: site, limit: 50 }), 'audit_site_page');
  });

  it('starts a later page at the cursor, as a condition of the index and not a filter', async () => {
    const first = await store.auditPage({ scope: site, limit: 50 });
    expect(first.next).not.toBeNull();
    const scan = expectWalk(
      await planOf({ scope: site, limit: 50, ...(first.next === null ? {} : { after: first.next }) }),
      'audit_site_page',
    );
    // The row comparison is in the index condition, so the walk begins at the
    // cursor instead of reading past every page already shown.
    expect(scan['Index Cond']).toContain('ROW(ts, seq) <');
  });

  // A read narrowed by a slice of time or by a filter is the planner's to
  // shape. Seen here: a wide slice is the same backward walk; a narrow one, or
  // a filter that few rows pass (one target), is that site's rows taken off
  // the index by bitmap and the few that match sorted, which is cheaper than
  // walking the whole site backwards to find them. What is held is what does
  // not change: one of the site's two indexes, the site and any range as its
  // condition, and never the table from its start.
  function expectSiteIndex(nodes: PlanNode[]): PlanNode {
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Seq Scan');
    const scans = nodes.filter((node) => node['Index Name'] !== undefined);
    expect(scans).toHaveLength(1);
    expect(['audit_site_page', 'audit_site_ts']).toContain(scans[0]?.['Index Name']);
    expect(scans[0]?.['Index Cond']).toContain('site_id =');
    return scans[0] as PlanNode;
  }

  it('reads a slice of time off an index of the site, narrow or wide', async () => {
    for (const to of [NOW + 50, NOW + 2000]) {
      const scan = expectSiteIndex(await planOf({ scope: site, limit: 50, from: NOW, to }));
      expect(scan['Index Cond']).toContain('ts >=');
      expect(scan['Index Cond']).toContain('ts <');
    }
  });

  it('reads a filtered page off an index of the site, with the cursor beside it', async () => {
    const first = await store.auditPage({ scope: site, limit: 50 });
    const after = first.next === null ? {} : { after: first.next };
    expectSiteIndex(await planOf({ scope: site, limit: 50, ...after, target: 't100' }));
    expectSiteIndex(
      await planOf({ scope: site, limit: 50, ...after, actorId: 'u_1', actions: ['member:set'] }),
    );
  });

  it("walks the team index for a team's page", async () => {
    expectWalk(await planOf({ scope: { kind: 'team', id: 't_1' }, limit: 20 }), 'audit_team_page');
  });

  it('reads every row of a site once across its pages, at this size', async () => {
    const seen = new Set<string>();
    let after: AuditPageQuery['after'];
    let rows = 0;
    for (;;) {
      const page = await store.auditPage({
        scope: site,
        limit: 200,
        ...(after === undefined ? {} : { after }),
      });
      for (const row of page.rows) seen.add(row.id);
      rows += page.rows.length;
      if (page.next === null) break;
      after = page.next;
    }
    expect(rows).toBe(3000);
    expect(seen.size).toBe(3000);
  });
});

describe('the rule the table itself holds a row of the log to', () => {
  const values = `$1, $2, '{"kind":"key","id":"k"}'::jsonb, 'x', 'GET /x', ARRAY[]::text[]`;

  it('refuses a row about neither a site nor a team, and one about both', async () => {
    const neither = await db.pool
      .query(`INSERT INTO audit_log (ts, actor, action, route, fields) VALUES ($1, '{}'::jsonb, 'x', 'y', ARRAY[]::text[])`, [NOW])
      .catch((error: unknown) => error);
    expect(isCode(neither, '23514')).toBe(true);
    const both = await db.pool
      .query(
        `INSERT INTO audit_log (site_id, team_id, ts, actor, action, route, fields)
         VALUES ('s_x', 't_x', ${values.replace('$1, $2, ', '$1, ')})`,
        [NOW],
      )
      .catch((error: unknown) => error);
    expect(isCode(both, '23514')).toBe(true);
    const count = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE site_id = 's_x' OR team_id = 't_x'`,
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it('holds an invitation to a team or a site and a role to one of the three', async () => {
    const insert = (kind: string, role: string): Promise<unknown> =>
      db.pool
        .query(
          `INSERT INTO invitations (id, token_hash, email, scope_kind, scope_id, role, identity,
                                    invited_by, created_at, expires_at)
           VALUES ($1, $1, 'a@example.com', $2, 'x', $3, false, 'u_1', 1, 2)`,
          [`inv_${kind}_${role}`, kind, role],
        )
        .catch((error: unknown) => error);
    expect(isCode(await insert('world', 'viewer'), '23514')).toBe(true);
    expect(isCode(await insert('team', 'admin'), '23514')).toBe(true);
    const member = await db.pool
      .query(`INSERT INTO site_members (site_id, user_id, role, identity) VALUES ('s', 'u', 'root', true)`)
      .catch((error: unknown) => error);
    expect(isCode(member, '23514')).toBe(true);
  });
});

describe('an image from before this ticket, against the table as it now is', () => {
  it('writes its site rows as it always did and never reads a row about a team', async () => {
    // The statement the adapter ran before AN-TEAM01, word for word: no
    // team_id among its columns.
    await db.pool.query(
      `INSERT INTO audit_log (site_id, ts, actor, action, route, target, fields)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::text[])`,
      ['s_old', NOW, '{"kind":"session","id":"u_1"}', 'read:identity', 'GET /x', 'ada', ['ip']],
    );
    await store.audit({
      teamId: 's_old',
      ts: NOW,
      actor: { kind: 'session', id: 'u_1' },
      action: 'member:set',
      route: 'PUT /y',
      fields: [],
    });
    // And the read it ran: by site, so a team's row is not in it.
    const trail = await db.pool.query<{ target: string | null }>(
      `SELECT site_id, ts, actor, action, route, target, fields
         FROM audit_log
        WHERE site_id = $1 AND ts >= $2 AND ts < $3
        ORDER BY ts, seq`,
      ['s_old', NOW, NOW + 1],
    );
    expect(trail.rows.map((row) => row.target)).toEqual(['ada']);
    // The new adapter reads the old image's row like any other.
    const page = await store.auditPage({ scope: { kind: 'site', id: 's_old' }, limit: 5 });
    expect(page.rows.map((row) => row.target)).toEqual(['ada']);
    expect(page.rows[0]?.siteId).toBe('s_old');
  });
});
