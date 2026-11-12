import {
  alertIdFor,
  annotationIdFor,
  defaultSiteSettings,
  digestIdFor,
  goalIdFor,
  StoreQueryError,
  type Alert,
  type Site,
} from '@chokh/store';
import { fixture, runAccountConformance } from '@chokh/store/conformance';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apply } from './migrate.js';
import { createPostgresStore, type PostgresStore } from './postgres.store.js';
import { PostgresSetupError } from './server.js';
import { createTestDatabase, databaseUrl, type TestDatabase } from './testing/database.js';

// Repository rule 5: every adapter passes the one conformance suite. This one
// runs against a real PostgreSQL, the schema applied by the migration and
// never by the adapter, so the suite runs against the database an operator
// would actually have.
//
// The account half only, for now: the reporting half is wired when the whole
// of AnalyticsStore is here, because its suite seeds one world and cannot pass
// by halves.
const ACCOUNT_TABLES = [
  'sites',
  'site_domains',
  'users',
  'teams',
  'api_keys',
  'audit_log',
  'goals',
  'funnels',
  'segments',
  'annotations',
  'alerts',
  'digests',
];

runAccountConformance('postgres', async () => {
  const db = await createTestDatabase('accounts');
  await apply(db.pool);
  const store = await createPostgresStore({ url: db.url, now: () => fixture.NOW });
  return {
    store,
    reset: async () => {
      await db.pool.query(`TRUNCATE ${ACCOUNT_TABLES.join(', ')}`);
    },
    close: async () => {
      await store.close();
      await db.drop();
    },
  };
});

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

function site(id: string, domains: string[]): Site {
  return { id, name: id, domains, settings: defaultSiteSettings() };
}

function silence(siteId: string, minutes: number): Alert {
  const condition = { kind: 'silence' as const, minutes };
  return {
    siteId,
    id: alertIdFor(siteId, condition),
    name: `Quiet ${minutes}`,
    condition,
    channels: [{ kind: 'email', to: 'ops@example.test' }],
    createdBy: 'u_1',
    createdAt: NOW,
    state: { firing: false },
    recent: [],
  };
}

describe('opening the adapter', () => {
  it('refuses a database the migration has not reached, and creates nothing in it', async () => {
    const db = await createTestDatabase('unmigrated');
    try {
      const refused = await createPostgresStore({ url: db.url }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PostgresSetupError);
      expect((refused as PostgresSetupError).code).toBe('NOT_MIGRATED');
      expect((refused as PostgresSetupError).message).toContain('migrate.js --apply');
      const left = await db.pool.query(
        `SELECT 1 FROM pg_class
          WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
      );
      expect(left.rowCount).toBe(0);
    } finally {
      await db.drop();
    }
  });

  it('refuses one the migration only half reached, and opens once it is whole', async () => {
    const db = await createTestDatabase('half');
    try {
      await apply(db.pool);
      await db.pool.query('DROP INDEX visitor_site_last_seen');
      const refused = await createPostgresStore({ url: db.url }).catch((error: unknown) => error);
      expect((refused as PostgresSetupError).code).toBe('NOT_MIGRATED');
      expect((refused as PostgresSetupError).message).toContain('is missing 1 of');

      await apply(db.pool);
      const store = await createPostgresStore({ url: db.url });
      expect(store.serverVersion).toMatch(/^\d+\.\d+/);
      await store.close();
    } finally {
      await db.drop();
    }
  });
});

describe('the adapter on its own pool', () => {
  let db: TestDatabase;
  let store: PostgresStore;
  const idle: Error[] = [];

  beforeAll(async () => {
    db = await createTestDatabase('pool');
    await apply(db.pool);
    store = await createPostgresStore({
      url: db.url,
      poolSize: 3,
      statementTimeoutMs: 400,
      onIdleError: (error) => idle.push(error),
      now: () => NOW,
    });
    await store.createSite(site('s_pool', ['pool.example']));
  });

  afterAll(async () => {
    await store.close().catch(() => undefined);
    await db.drop();
  });

  it('holds no more connections than it was told to', async () => {
    await Promise.all(Array.from({ length: 12 }, () => store.sites()));
    expect(store.pool.totalCount).toBeLessThanOrEqual(3);
    expect(store.pool.options.max).toBe(3);
  });

  it('cancels a statement that outlives its limit, and the connection is fit to use after', async () => {
    const started = Date.now();
    const cancelled = await store.pool.query('SELECT pg_sleep(5)').catch((error: unknown) => error);
    expect((cancelled as { code?: string }).code).toBe('57014');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await store.site('s_pool'))?.id).toBe('s_pool');
  });

  it('hands back counts and instants as numbers', async () => {
    await store.createUser({ id: 'u_n', email: 'n@example.com', createdAt: NOW });
    const count = await store.userCount();
    expect(count).toBe(1);
    expect(typeof count).toBe('number');
    expect(typeof (await store.userById('u_n'))?.createdAt).toBe('number');
  });

  it('survives the server dropping a connection nobody was using', async () => {
    // What a restart or a failover does to every idle connection of a pool.
    const mine = await store.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = mine.rows[0]?.pid;
    const admin = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
    try {
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      await admin.end();
    }
    // The pool hears of it on its own time; the next calls must simply work.
    for (let attempt = 0; attempt < 50 && idle.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(idle.length).toBeGreaterThan(0);
    expect((await store.site('s_pool'))?.id).toBe('s_pool');
    expect(await store.userCount()).toBe(1);
  });

  it('takes a NUL and a broken surrogate out of text on the way in', async () => {
    // Postgres can store neither; one of them in one row would otherwise be a
    // refused statement. Text columns, a jsonb value and a jsonb key.
    const nul = String.fromCharCode(0);
    const half = String.fromCharCode(0xd83d);
    const id = goalIdFor('s_pool', 'event', 'sign up');
    await store.createGoal({
      siteId: 's_pool',
      id,
      name: `Sign${nul} up ${half}!`,
      kind: 'event',
      match: `sign${nul}up`,
      createdBy: 'u_1',
      createdAt: NOW,
    });
    const goal = await store.goal('s_pool', id);
    expect(goal?.name).toBe(`Sign up ${String.fromCharCode(0xfffd)}!`);
    expect(goal?.match).toBe('signup');

    await store.audit({
      siteId: 's_pool',
      ts: NOW,
      actor: { kind: 'session', id: `u${nul}1`, email: `a${half}@example.com` },
      action: 'read:identity',
      route: 'GET /x',
      fields: [`i${nul}p`],
    });
    const [row] = await store.auditTrail('s_pool', NOW, NOW + 1);
    expect(row?.actor).toEqual({
      kind: 'session',
      id: 'u1',
      email: `a${String.fromCharCode(0xfffd)}@example.com`,
    });
    expect(row?.fields).toEqual(['ip']);

    // And a whole pair is a character like any other: it is not touched.
    const whole = 'সিলেট 😀';
    const kept = annotationIdFor('s_pool', NOW, 'note', whole);
    await store.createAnnotation({
      siteId: 's_pool',
      id: kept,
      at: NOW,
      kind: 'note',
      text: whole,
      createdBy: 'u_1',
      createdAt: NOW,
    });
    expect((await store.annotation('s_pool', kept))?.text).toBe(whole);
  });
});

describe('two processes at once', () => {
  let db: TestDatabase;
  let store: PostgresStore;

  beforeAll(async () => {
    db = await createTestDatabase('races');
    await apply(db.pool);
    store = await createPostgresStore({ url: db.url, now: () => NOW });
    await store.createSite(site('s_race', ['race.example']));
  });

  afterAll(async () => {
    await store.close();
    await db.drop();
  });

  it('give an alert bucket and a digest period to exactly one of them', async () => {
    const alert = silence('s_race', 30);
    await store.createAlert(alert);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claimAlertCheck('s_race', alert.id, 500)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    const id = digestIdFor('s_race', 'daily');
    await store.createDigest({
      siteId: 's_race',
      id,
      cadence: 'daily',
      to: ['ops@example.test'],
      hour: 8,
      createdBy: 'u_1',
      createdAt: NOW,
    });
    const sends = await Promise.all(
      Array.from({ length: 8 }, () => store.claimDigestSend('s_race', id, 'd:2026-09-24')),
    );
    expect(sends.filter(Boolean)).toHaveLength(1);
  });

  it('give a domain to exactly one site, and leave nothing of the other', async () => {
    const results = await Promise.all(
      ['s_a', 's_b', 's_c', 's_d'].map((id) =>
        store.createSite(site(id, [`${id}.example`, 'shared.example'])).then(
          () => 'created',
          (error: unknown) => (error instanceof StoreQueryError ? error.code : 'threw'),
        ),
      ),
    );
    expect(results.filter((each) => each === 'created')).toHaveLength(1);
    expect(results.filter((each) => each === 'DOMAIN_TAKEN')).toHaveLength(3);
    const sites = (await store.sites()).map((each) => each.id).filter((id) => id !== 's_race');
    expect(sites).toHaveLength(1);
    // The losers' own domains went with them: each can be registered again.
    const loser = ['s_a', 's_b', 's_c', 's_d'].find((id) => id !== sites[0]);
    await store.createSite(site(`${loser}_again`, [`${loser}.example`]));
  });

  it('keep both of two settings patched at the same moment', async () => {
    await Promise.all([
      store.updateSite('s_race', { settings: { retentionDays: 45 } }),
      store.updateSite('s_race', { settings: { ipMode: 'full' } }),
      store.updateSite('s_race', { name: 'Race' }),
    ]);
    const after = await store.site('s_race');
    expect(after?.settings.retentionDays).toBe(45);
    expect(after?.settings.ipMode).toBe('full');
    expect(after?.name).toBe('Race');
  });

  it('keep every member added to one team at the same moment', async () => {
    await store.createTeam({ id: 't_race', name: 'Race', members: [] });
    await Promise.all(
      ['u_1', 'u_2', 'u_3', 'u_4', 'u_5'].map((userId) =>
        store.setTeamMember('t_race', { userId, role: 'viewer', identity: false }),
      ),
    );
    const team = await store.team('t_race');
    expect(team?.members.map((member) => member.userId).sort()).toEqual([
      'u_1',
      'u_2',
      'u_3',
      'u_4',
      'u_5',
    ]);
    // A change of role moves nobody out and puts nobody in twice.
    const changed = await store.setTeamMember('t_race', { userId: 'u_3', role: 'editor', identity: true });
    expect(changed.members).toHaveLength(5);
    expect(changed.members[4]).toEqual({ userId: 'u_3', role: 'editor', identity: true });
    expect((await store.teamsForUser('u_3')).map((each) => each.id)).toEqual(['t_race']);
  });
});

describe('closing the adapter', () => {
  it('serves a caller already waiting for a connection before it ends the pool', async () => {
    const db = await createTestDatabase('close_queue');
    try {
      await apply(db.pool);
      // One connection, so the second statement has to queue behind the first.
      const store = await createPostgresStore({ url: db.url, poolSize: 1 });
      const first = store.pool.query('SELECT pg_sleep(0.3)');
      const queued = store.userCount();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(store.pool.waitingCount).toBe(1);
      await store.close();
      await first;
      // Without the wait in close this promise is never settled at all.
      expect(await queued).toBe(0);
    } finally {
      await db.drop();
    }
  });

  it('lets a statement in flight finish, then refuses the next call', async () => {
    const db = await createTestDatabase('close');
    try {
      await apply(db.pool);
      const store = await createPostgresStore({ url: db.url });
      await store.createSite(site('s_close', ['close.example']));
      // A write that is still running when the shutdown begins.
      const inFlight = store.pool.query<{ done: number }>(
        `WITH waited AS (SELECT pg_sleep(0.4))
         INSERT INTO users (id, email, created_at) SELECT 'u_late', 'late@example.com', 1 FROM waited
         RETURNING 1 AS done`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await store.close();
      expect((await inFlight).rows).toEqual([{ done: 1 }]);
      const kept = await db.pool.query(`SELECT id FROM users`);
      expect(kept.rows).toEqual([{ id: 'u_late' }]);
      await expect(store.site('s_close')).rejects.toThrow();
    } finally {
      await db.drop();
    }
  });
});
