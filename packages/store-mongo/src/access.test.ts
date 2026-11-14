import {
  StoreQueryError,
  defaultSiteSettings,
  type AuditRecord,
  type Site,
  type StoredInvitation,
} from '@chokh/store';
import { MongoClient, type Db, type Document } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auditPageFind } from './access.js';
import { apply, verify } from './migrate.js';
import { createMongoStore, type MongoStore } from './mongo.store.js';
import { schema } from './schema.js';

// What the conformance suite cannot see about access on MongoDB: that the
// three new collections wait for the migration and nothing older does, that
// the revision a team's writes are guarded by stays inside the adapter, and
// that a page of the log comes off an index.

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

let server: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
}, 120_000);

afterAll(async () => {
  await client.close();
  await server.stop();
});

async function open(name: string): Promise<MongoStore> {
  return createMongoStore({ client, dbName: name, now: () => NOW });
}

function site(id: string): Site {
  return { id, name: id, domains: [`${id}.example`], settings: defaultSiteSettings() };
}

function invitation(id: string, email: string): StoredInvitation {
  return {
    id,
    tokenHash: `hash-${id}`,
    email,
    scope: { kind: 'team', id: 'default' },
    role: 'viewer',
    identity: false,
    invitedBy: 'u_1',
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<StoreQueryError | null> {
  try {
    await run();
  } catch (error) {
    if (error instanceof StoreQueryError) return error;
    throw error;
  }
  return null;
}

describe('a database the migration has not reached', () => {
  let store: MongoStore;
  let db: Db;

  beforeAll(async () => {
    store = await open('chokh_unmigrated');
    db = store.db;
    // Everything an install had before this ticket, written with no index
    // anywhere, the way it has always been allowed to be.
    await store.createSite(site('s_one'));
    await store.createUser({ id: 'u_1', email: 'one@example.com', passwordHash: 'h', createdAt: NOW });
    await store.createTeam({
      id: 'default',
      name: 'Default',
      members: [{ userId: 'u_1', role: 'owner', identity: true }],
    });
  });

  it('refuses an invitation, an identity and a site row, naming the command, and writes none', async () => {
    const refused = [
      await refusal(() => store.createInvitation(invitation('inv_1', 'a@example.com'))),
      await refusal(() =>
        store.linkIdentity({
          issuer: 'https://login.example.test',
          subject: 's',
          userId: 'u_1',
          linkedAt: NOW,
        }),
      ),
      await refusal(() =>
        store.setSiteMember({ siteId: 's_one', userId: 'u_1', role: 'viewer', identity: false }),
      ),
    ];
    for (const error of refused) {
      expect(error?.code).toBe('MIGRATION_REQUIRED');
      expect(error?.message).toContain('node packages/store-mongo/dist/migrate.js --apply');
    }
    for (const name of ['invitations', 'identities', 'site_members']) {
      expect(await db.collection(name).countDocuments()).toBe(0);
    }
  });

  it('still serves everything that existed before, and reads the new things as empty', async () => {
    await store.setTeamMember('default', { userId: 'u_2', role: 'viewer', identity: false });
    const changed = await store.changeTeamMember('default', 'u_2', {
      role: 'editor',
      identity: false,
    });
    expect(changed.members.map((member) => member.role)).toEqual(['owner', 'editor']);
    expect(await store.bumpSessionEpoch('u_1')).toBe(1);
    await store.audit({
      siteId: 's_one',
      ts: NOW,
      actor: { kind: 'session', id: 'u_1' },
      action: 'read:identity',
      route: 'GET /x',
      fields: ['ip'],
    });
    expect(await store.auditTrail('s_one', NOW, NOW + 1)).toHaveLength(1);
    expect((await store.auditPage({ scope: { kind: 'site', id: 's_one' }, limit: 10 })).rows).toHaveLength(1);
    expect(await store.siteGrantsForUser('u_1')).toEqual([]);
    expect(await store.siteMembers('s_one')).toEqual([]);
    expect(await store.openInvitations({ kind: 'team', id: 'default' })).toEqual([]);
    expect(await store.userByIdentity('https://login.example.test', 's')).toBeNull();
    expect(await store.claimInvitation('hash-inv_1', NOW, 'u_9')).toBeNull();
    expect((await store.site('s_one'))?.id).toBe('s_one');
  });

  it('writes them as soon as the migration has run, with no restart', async () => {
    await apply(db);
    await store.createInvitation(invitation('inv_1', 'a@example.com'));
    await store.linkIdentity({
      issuer: 'https://login.example.test',
      subject: 's',
      userId: 'u_1',
      linkedAt: NOW,
    });
    await store.setSiteMember({ siteId: 's_one', userId: 'u_1', role: 'viewer', identity: false });
    expect((await store.invitation('inv_1'))?.email).toBe('a@example.com');
    expect((await store.userByIdentity('https://login.example.test', 's'))?.id).toBe('u_1');
    expect(await store.siteMembers('s_one')).toHaveLength(1);
  });

  it('asks again after an index is taken away only when it has not seen it yet', async () => {
    // A second store on the same database has seen nothing, and one index of
    // the three it needs is gone: refused. The first store, which saw them
    // all, is not asked again on every write.
    await db.collection('invitations').dropIndex('invitation_open_address');
    const fresh = await open('chokh_unmigrated');
    expect(
      (await refusal(() => fresh.createInvitation(invitation('inv_2', 'b@example.com'))))?.code,
    ).toBe('MIGRATION_REQUIRED');
    await apply(db);
    await fresh.createInvitation(invitation('inv_2', 'b@example.com'));
    expect((await fresh.invitation('inv_2'))?.id).toBe('inv_2');
  });
});

describe('a team on MongoDB', () => {
  let store: MongoStore;

  beforeAll(async () => {
    store = await open('chokh_teams');
    await apply(store.db);
    await store.createUser({ id: 'u_1', email: 'one@example.com', passwordHash: 'h', createdAt: NOW });
  });

  it('keeps its revision to itself', async () => {
    await store.createTeam({
      id: 't_1',
      name: 'One',
      members: [{ userId: 'u_1', role: 'owner', identity: true }],
    });
    const set = await store.setTeamMember('t_1', { userId: 'u_2', role: 'viewer', identity: false });
    const changed = await store.changeTeamMember('t_1', 'u_2', { role: 'editor', identity: false });
    const renamed = await store.renameTeam('t_1', 'Uno');
    const read = await store.team('t_1');
    const mine = await store.teamsForUser('u_1');
    for (const team of [set, changed, renamed, read, ...mine]) {
      expect(Object.keys(team ?? {}).sort()).toEqual(['id', 'members', 'name']);
    }
    // And it is there, counting the three writes of the list.
    const doc = await store.db.collection('teams').findOne({ id: 't_1' });
    expect(doc?.rev).toBe(2);
  });

  it('changes a team written before the revision existed', async () => {
    await store.db.collection('teams').insertOne({
      id: 't_old',
      name: 'Old',
      members: [
        { userId: 'u_1', role: 'owner', identity: true },
        { userId: 'u_3', role: 'viewer', identity: false },
      ],
    });
    const changed = await store.changeTeamMember('t_old', 'u_3', null);
    expect(changed.members).toEqual([{ userId: 'u_1', role: 'owner', identity: true }]);
    expect((await store.changeTeamMember('t_old', 'u_4', { role: 'viewer', identity: false })).members).toHaveLength(2);
  });

  it('writes a member whose id looks like an expression as the text it is', async () => {
    const set = await store.setTeamMember('t_1', { userId: '$members', role: 'viewer', identity: false });
    expect(set.members.map((member) => member.userId)).toEqual(['u_1', 'u_2', '$members']);
    // Set again, the one row is replaced and not doubled.
    const again = await store.setTeamMember('t_1', { userId: '$members', role: 'editor', identity: false });
    expect(again.members.filter((member) => member.userId === '$members')).toEqual([
      { userId: '$members', role: 'editor', identity: false },
    ]);
  });
});

describe('a page of the audit log on MongoDB', () => {
  let store: MongoStore;
  let db: Db;

  const row = (scope: { siteId: string } | { teamId: string }, ts: number, target: string): AuditRecord => ({
    ...scope,
    ts,
    actor: { kind: 'session', id: 'u_1' },
    action: 'read:identity',
    route: 'GET /x',
    target,
    fields: ['ip'],
  });

  beforeAll(async () => {
    store = await open('chokh_audit');
    db = store.db;
    await apply(db);
    const rows: AuditRecord[] = [];
    for (let index = 0; index < 600; index += 1) {
      rows.push(row({ siteId: `s_${index % 3}` }, NOW + Math.floor(index / 4), `t${index}`));
    }
    for (let index = 0; index < 60; index += 1) {
      rows.push(row({ teamId: 't_1' }, NOW + index, `team${index}`));
    }
    await db.collection('audit_log').insertMany(rows);
  });

  interface Plan {
    stages: string[];
    indexes: string[];
    keysExamined: number;
  }

  function stagesOf(plan: Document): Plan {
    const stages: string[] = [];
    const indexes: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const each = node as Record<string, unknown>;
      if (typeof each['stage'] === 'string') stages.push(each['stage']);
      if (typeof each['indexName'] === 'string') indexes.push(each['indexName']);
      for (const value of Object.values(each)) walk(value);
    };
    walk((plan['queryPlanner'] as Document | undefined)?.['winningPlan']);
    const stats = plan['executionStats'] as { totalKeysExamined: number } | undefined;
    return { stages, indexes, keysExamined: stats?.totalKeysExamined ?? -1 };
  }

  async function planOf(query: Parameters<typeof auditPageFind>[0]): Promise<Plan> {
    const read = auditPageFind(query);
    const plan = (await db
      .collection<AuditRecord>('audit_log')
      .find(read.filter)
      .sort(read.sort)
      .limit(read.limit)
      .explain('executionStats')) as unknown as Document;
    return stagesOf(plan);
  }

  it("walks the page index for a site's first page and for a later one, and sorts nothing", async () => {
    const first = await planOf({ scope: { kind: 'site', id: 's_1' }, limit: 50 });
    expect(first.indexes).toEqual(['audit_site_page']);
    expect(first.stages).not.toContain('SORT');
    expect(first.stages).not.toContain('COLLSCAN');

    // The third page starts its walk at the cursor: it reads about a page of
    // keys, not the two pages before it as well. A cursor said as a choice
    // alone read 150 and more here, which is the mistake this holds off.
    let after = (await store.auditPage({ scope: { kind: 'site', id: 's_1' }, limit: 50 })).next;
    expect(after).not.toBeNull();
    if (after !== null) {
      after = (await store.auditPage({ scope: { kind: 'site', id: 's_1' }, limit: 50, after })).next;
    }
    expect(after).not.toBeNull();
    const later = await planOf({
      scope: { kind: 'site', id: 's_1' },
      limit: 50,
      ...(after === null ? {} : { after }),
    });
    expect(later.indexes).toEqual(['audit_site_page']);
    expect(later.stages).not.toContain('SORT');
    expect(later.stages).not.toContain('COLLSCAN');
    expect(later.keysExamined).toBeGreaterThan(0);
    expect(later.keysExamined).toBeLessThanOrEqual(60);

    // With filters beside the cursor it is still an index and still no sort.
    const filtered = await planOf({
      scope: { kind: 'site', id: 's_1' },
      limit: 50,
      ...(after === null ? {} : { after }),
      from: NOW,
      actorId: 'u_1',
      actions: ['read:identity'],
    });
    expect(filtered.stages).toContain('IXSCAN');
    expect(filtered.stages).not.toContain('SORT');
    expect(filtered.stages).not.toContain('COLLSCAN');
  });

  it("walks the team index for a team's page", async () => {
    const plan = await planOf({ scope: { kind: 'team', id: 't_1' }, limit: 20 });
    expect(plan.indexes).toEqual(['audit_team_page']);
    expect(plan.stages).not.toContain('SORT');
    expect(plan.stages).not.toContain('COLLSCAN');
  });

  it('compares an object where a string was expected as a value, and finds nothing', async () => {
    const hostile = { $ne: null } as unknown as string;
    const site = { kind: 'site', id: 's_1' } as const;
    expect((await store.auditPage({ scope: site, limit: 5 })).rows).toHaveLength(5);
    expect((await store.auditPage({ scope: site, limit: 5, target: hostile })).rows).toEqual([]);
    expect((await store.auditPage({ scope: site, limit: 5, actorId: hostile })).rows).toEqual([]);
    expect(
      (await store.auditPage({ scope: { kind: 'site', id: hostile }, limit: 5 })).rows,
    ).toEqual([]);
  });
});

describe('the migration, coming from the shape before access existed', () => {
  it('creates the three collections and their indexes and touches nothing else', async () => {
    const db = client.db('chokh_upgrade');
    await apply(db);
    // Back to what an install had: no access collections, no page indexes.
    for (const name of ['site_members', 'invitations', 'identities']) {
      await db.collection(name).drop();
    }
    await db.collection('audit_log').dropIndex('audit_site_page');
    await db.collection('audit_log').dropIndex('audit_team_page');
    const before = await verify(db);
    expect(before.missingIndexes).toBe(10);

    const applied = await apply(db);
    expect(applied.collectionsCreated).toEqual(['site_members', 'invitations', 'identities']);
    expect([...applied.indexesCreated].sort()).toEqual([
      'audit_log.audit_site_page',
      'audit_log.audit_team_page',
      'identities.identity_subject',
      'identities.identity_user_issuer',
      'invitations.invitation_id',
      'invitations.invitation_open_address',
      'invitations.invitation_sender',
      'invitations.invitation_token',
      'site_members.site_member_key',
      'site_members.site_member_user',
    ]);
    expect(applied.missingIndexes).toBe(0);
    expect(applied.undeclaredIndexes).toBe(0);
    expect(applied.collections).toHaveLength(schema.length);
    const again = await apply(db);
    expect(again.collectionsCreated).toEqual([]);
    expect(again.indexesCreated).toEqual([]);
  });
});
