import { createHash, createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NOW,
  OWNER_EMAIL,
  SITE_ID,
  TEAM_ID,
  createHarness,
  envelope,
  expectFailure,
  testSite,
  type Harness,
} from './api.test-utils.js';
import { AUDIT_LISTING_MS } from '../lib/audit-cursor.js';
import { signHs256 } from '../lib/jwt.js';
import { ssoClaimsFor } from '../services/sso.service.js';
import type {
  AccessScope,
  AuditEntry,
  AuditRecord,
  Role,
  StoredEvent,
} from '../store/AnalyticsStore.js';

// The audit log, read (AN-TEAM01): who may read which log, what a page is,
// that opening the log is itself recorded and cannot be done without a
// record, and what a caller without read:identity is shown of it.

const SIBLING = 's_sibling';
const SPARE_TEAM = 't_spare';
const SITE_LOG = `/api/sites/${SITE_ID}/audit`;
const SIBLING_LOG = `/api/sites/${SIBLING}/audit`;
const TEAM_LOG = `/api/teams/${TEAM_ID}/audit`;
const SITE_SCOPE: AccessScope = { kind: 'site', id: SITE_ID };
const TEAM_SCOPE: AccessScope = { kind: 'team', id: TEAM_ID };
const MINUTE = 60_000;

interface Row {
  id: string;
  ts: number;
  action: string;
  kind: string;
  route: string;
  actor: { kind: string; id: string; email?: string };
  target?: string;
  fields: string[];
  siteId?: string;
  teamId?: string;
}

interface Page {
  rows: Row[];
  accounts: Record<string, { email: string; name?: string }>;
  next: string | null;
}

interface Person {
  cookie: string;
  userId: string;
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({
    sites: [testSite(), testSite({ id: SIBLING, domains: ['sibling.example'] })],
  });
  await harness.store.createTeam({ id: SPARE_TEAM, name: 'Spare', members: [] });
});

afterEach(async () => {
  await harness.close();
});

// An account is a registration and a sign-in, and both count against the
// limit on attempts from one address, so the clock moves on before each.
async function member(email: string, role: Role, identity = false, teamId = TEAM_ID): Promise<Person> {
  harness.setNow(harness.now() + 61_000);
  return harness.account({ email, role, identity, teamId });
}

// Somebody with an account and no place in any team.
async function guest(email: string): Promise<Person> {
  const made = await member(email, 'viewer', false, SPARE_TEAM);
  await harness.store.changeTeamMember(SPARE_TEAM, made.userId, null);
  return made;
}

function read(url: string, headers: Record<string, string>) {
  return harness.app.inject({ method: 'GET', url, headers });
}

function asOwner(): Record<string, string> {
  return { cookie: harness.owner.cookie };
}

async function page(url: string, headers: Record<string, string> = asOwner()): Promise<Page> {
  const response = await read(url, headers);
  if (response.statusCode !== 200) {
    throw new Error(`GET ${url} answered ${response.statusCode}: ${response.body}`);
  }
  return envelope<Page>(response.body).data as Page;
}

// The log as the store holds it, which is what a read leaves behind.
async function stored(scope: AccessScope, action?: string): Promise<AuditEntry[]> {
  const found = await harness.store.auditPage({ scope, limit: 200 });
  return action === undefined ? found.rows : found.rows.filter((row) => row.action === action);
}

// A row as an identity read writes it: the owner looking at one visitor.
function looked(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    siteId: SITE_ID,
    ts: harness.now(),
    actor: { kind: 'session', id: harness.owner.userId, email: OWNER_EMAIL },
    action: 'read:identity',
    route: 'GET /api/sites/:siteId/visitors/:visitorId',
    target: 'v_somebody',
    fields: ['ips', 'userId'],
    ...overrides,
  };
}

async function seed(count: number, at: (index: number) => number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await harness.store.audit(looked({ ts: at(index), target: `v_${index}` }));
  }
}

function post(url: string, payload: object, cookie = harness.owner.cookie) {
  return harness.app.inject({ method: 'POST', url, headers: { cookie }, payload });
}

async function invite(url: string, email: string): Promise<{ id: string; token: string }> {
  const response = await post(url, { email, role: 'viewer', identity: false });
  if (response.statusCode !== 201) {
    throw new Error(`invite(${email}) answered ${response.statusCode}: ${response.body}`);
  }
  const data = envelope<{ invitation: { id: string }; once: { token: string } }>(response.body).data;
  return { id: data?.invitation.id ?? '', token: data?.once.token ?? '' };
}

describe('who may read a log', () => {
  it("a site's: admin on that site, held by a person or by a key, and nobody else", async () => {
    const viewer = await member('viewer@test.example', 'viewer', true);
    const editor = await member('editor@test.example', 'editor', true);

    expect((await read(SITE_LOG, asOwner())).statusCode).toBe(200);
    expect((await read(SITE_LOG, { authorization: await harness.key(['admin']) })).statusCode).toBe(200);

    // Reading the numbers, and even reading who they are about, is not
    // reading who else read them.
    expectFailure(await read(SITE_LOG, { cookie: viewer.cookie }), 403, 'SCOPE_REQUIRED');
    expectFailure(await read(SITE_LOG, { cookie: editor.cookie }), 403, 'SCOPE_REQUIRED');
    expectFailure(
      await read(SITE_LOG, {
        authorization: await harness.key(['read:stats', 'read:identity', 'write:events']),
      }),
      403,
      'SCOPE_REQUIRED',
    );
    expectFailure(await read(SITE_LOG, {}), 401, 'UNAUTHENTICATED');
    // A key is for one site: admin on the sibling is nothing here.
    expectFailure(
      await read(SITE_LOG, { authorization: await harness.key(['admin'], SIBLING) }),
      403,
      'SITE_FORBIDDEN',
    );
  });

  it("an owner of one site reads that site's log, not its sibling's and not the team's", async () => {
    const client = await guest('client@elsewhere.example');
    await harness.store.setSiteMember({
      siteId: SIBLING,
      userId: client.userId,
      role: 'owner',
      identity: true,
    });
    const cookie = await harness.signIn('client@elsewhere.example');
    expect((await read(SIBLING_LOG, { cookie })).statusCode).toBe(200);
    expectFailure(await read(SITE_LOG, { cookie }), 403, 'SITE_FORBIDDEN');
    expectFailure(await read(TEAM_LOG, { cookie }), 403, 'FORBIDDEN');
  });

  it("a team's: a person who owns that team, and nobody else", async () => {
    const viewer = await member('viewer@test.example', 'viewer', true);
    const editor = await member('editor@test.example', 'editor', true);
    const elsewhere = await member('elsewhere@test.example', 'owner', true, SPARE_TEAM);

    expect((await read(TEAM_LOG, asOwner())).statusCode).toBe(200);
    expectFailure(await read(TEAM_LOG, { cookie: viewer.cookie }), 403, 'FORBIDDEN');
    expectFailure(await read(TEAM_LOG, { cookie: editor.cookie }), 403, 'FORBIDDEN');
    // Owning a team is owning that team.
    expectFailure(await read(TEAM_LOG, { cookie: elsewhere.cookie }), 403, 'FORBIDDEN');
    // A key holds scopes on one site and owns nothing.
    expectFailure(
      await read(TEAM_LOG, { authorization: await harness.key(['admin', 'read:identity']) }),
      403,
      'FORBIDDEN',
    );
    expectFailure(await read(TEAM_LOG, {}), 401, 'UNAUTHENTICATED');
    expectFailure(await read('/api/teams/t_nowhere/audit', asOwner()), 404, 'UNKNOWN_TEAM');
  });
});

describe('a page of the log', () => {
  it('is newest first, fifty rows unless asked, and never more than two hundred', async () => {
    await seed(60, (index) => NOW - index * 1000);
    const response = await read(SITE_LOG, asOwner());
    const body = envelope<Page>(response.body);
    expect(body.meta).toEqual({ identity: true, limit: 50 });
    const rows = body.data?.rows ?? [];
    expect(rows).toHaveLength(50);
    expect(rows.map((row) => row.ts)).toEqual([...rows.map((row) => row.ts)].sort((a, b) => b - a));
    expect(rows[0]?.target).toBe('v_0');
    expect(body.data?.next).toEqual(expect.any(String));

    expect((await page(`${SITE_LOG}?limit=200`)).rows.length).toBeGreaterThan(60);
    expectFailure(await read(`${SITE_LOG}?limit=201`, asOwner()), 400, 'INVALID_AUDIT_QUERY');
    expectFailure(await read(`${SITE_LOG}?limit=0`, asOwner()), 400, 'INVALID_AUDIT_QUERY');
    expectFailure(await read(`${SITE_LOG}?limit=many`, asOwner()), 400, 'INVALID_AUDIT_QUERY');
  });

  it('says what each row is: the store row, and the kind of thing it records', async () => {
    await harness.store.audit(looked({ ts: NOW - 4000 }));
    await harness.store.audit(
      looked({ ts: NOW - 3000, action: 'member:set', target: harness.owner.userId, fields: ['role: viewer'] }),
    );
    await harness.store.audit(looked({ ts: NOW - 2000, action: 'read:audit', fields: [] }));
    // Written by a version that knew an action this one does not.
    await harness.store.audit(looked({ ts: NOW - 1000, action: 'something:else' }));
    const { rows } = await page(SITE_LOG);
    expect(rows.map((row) => [row.action, row.kind])).toEqual([
      ['something:else', 'other'],
      ['read:audit', 'log'],
      ['member:set', 'access'],
      ['read:identity', 'identity'],
    ]);
    expect(rows[3]).toEqual({
      id: expect.any(String),
      siteId: SITE_ID,
      ts: NOW - 4000,
      actor: { kind: 'session', id: harness.owner.userId, email: OWNER_EMAIL },
      action: 'read:identity',
      kind: 'identity',
      route: 'GET /api/sites/:siteId/visitors/:visitorId',
      target: 'v_somebody',
      fields: ['ips', 'userId'],
    });
  });

  it('walks to the end showing every row once, also where several share one millisecond', async () => {
    // Seven rows to each instant, so every page boundary falls inside a group.
    await seed(130, (index) => NOW - Math.floor(index / 7) * 1000);
    const seen: Row[] = [];
    let url = `${SITE_LOG}?limit=50`;
    for (let pages = 0; pages < 10; pages += 1) {
      const answer = await page(url);
      seen.push(...answer.rows);
      if (answer.next === null) break;
      url = `${SITE_LOG}?limit=50&cursor=${encodeURIComponent(answer.next)}`;
    }
    expect(seen).toHaveLength(130);
    expect(new Set(seen.map((row) => row.id)).size).toBe(130);
    expect(new Set(seen.map((row) => row.target)).size).toBe(130);
    expect(seen.map((row) => row.ts)).toEqual([...seen.map((row) => row.ts)].sort((a, b) => b - a));
  });

  it('answers a page that is the last one with no cursor', async () => {
    await seed(3, (index) => NOW - index);
    expect((await page(SITE_LOG)).next).toBeNull();
  });
});

describe('opening the log', () => {
  it('is recorded: one row for the opening, none for a later page of the same listing', async () => {
    await seed(120, (index) => NOW - index * 1000);
    harness.setNow(NOW + MINUTE);
    const first = await page(SITE_LOG);
    // Not shown to the read that wrote it.
    expect(first.rows.some((row) => row.action === 'read:audit')).toBe(false);
    expect(await stored(SITE_SCOPE, 'read:audit')).toEqual([
      {
        id: expect.any(String),
        siteId: SITE_ID,
        ts: NOW + MINUTE,
        actor: { kind: 'session', id: harness.owner.userId, email: OWNER_EMAIL },
        action: 'read:audit',
        route: 'GET /api/sites/:siteId/audit',
        // What the page carried, from the pass that built it.
        fields: ['email', 'target'],
      },
    ]);

    harness.setNow(NOW + 2 * MINUTE);
    const second = await page(`${SITE_LOG}?cursor=${encodeURIComponent(first.next ?? '')}`);
    expect(second.rows).toHaveLength(50);
    await page(`${SITE_LOG}?cursor=${encodeURIComponent(second.next ?? '')}`);
    expect(await stored(SITE_SCOPE, 'read:audit')).toHaveLength(1);

    // Opened again, it is a second act and a second row, and the first shows.
    harness.setNow(NOW + 3 * MINUTE);
    const again = await page(SITE_LOG);
    expect(again.rows[0]).toMatchObject({ action: 'read:audit', kind: 'log', ts: NOW + MINUTE });
    expect(await stored(SITE_SCOPE, 'read:audit')).toHaveLength(2);
  });

  it('is recorded for a key as for a person, and in the log that was opened', async () => {
    const authorization = await harness.key(['admin', 'read:identity']);
    await page(SITE_LOG, { authorization });
    const [row] = await stored(SITE_SCOPE, 'read:audit');
    expect(row?.actor.kind).toBe('key');
    expect(row?.actor.email).toBeUndefined();
    expect(row?.siteId).toBe(SITE_ID);

    await page(TEAM_LOG);
    expect(await stored(TEAM_SCOPE, 'read:audit')).toEqual([
      expect.objectContaining({
        teamId: TEAM_ID,
        route: 'GET /api/teams/:teamId/audit',
        actor: { kind: 'session', id: harness.owner.userId, email: OWNER_EMAIL },
      }),
    ]);
    // Each in its own log and not the other's.
    expect(await stored(SITE_SCOPE, 'read:audit')).toHaveLength(1);
    expect((await stored(TEAM_SCOPE))[0]?.siteId).toBeUndefined();
  });

  it('says who was asked about, when the log was asked about one target', async () => {
    await harness.store.audit(looked({ ts: NOW - 1000, target: 'v_ada' }));
    const answer = await page(`${SITE_LOG}?target=v_ada`);
    expect(answer.rows.map((row) => row.target)).toEqual(['v_ada']);
    expect((await stored(SITE_SCOPE, 'read:audit'))[0]?.target).toBe('v_ada');
  });

  it('is not recorded when the read was refused', async () => {
    const viewer = await member('viewer@test.example', 'viewer', true);
    await read(SITE_LOG, { cookie: viewer.cookie });
    await read(`${SITE_LOG}?limit=500`, asOwner());
    expect(await stored(SITE_SCOPE, 'read:audit')).toEqual([]);
  });
});

// If a cursor were only encoded, somebody who may read the log could make one
// up that points past the newest row and read all of it "from the second
// page", with no row saying they had.
describe('a cursor', () => {
  let next: string;

  beforeEach(async () => {
    await seed(120, (index) => NOW - index * 1000);
    harness.setNow(NOW + MINUTE);
    next = (await page(SITE_LOG)).next ?? '';
  });

  const carry = (url: string, cursor: string, headers = asOwner()) =>
    read(`${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`, headers);

  it('is only ever one this server gave out: a made-up one reads nothing and leaves no row', async () => {
    const body = (parts: unknown[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
    const [mine, signature] = [next.slice(0, next.lastIndexOf('.')), next.slice(next.lastIndexOf('.') + 1)];
    const ahead = body([NOW + 10 * MINUTE, '999999999', NOW + MINUTE]);
    for (const forged of [
      // The store's own cursor, encoded and unsigned, pointing past the newest row.
      ahead,
      // The same with the signature of a real one.
      `${ahead}.${signature}`,
      // And signed, with a key that is not this server's.
      `${ahead}.${createHmac('sha256', 'not-this-servers-secret').update(ahead).digest('base64url')}`,
      // A real body with a signature cut short.
      `${mine}.${signature.slice(0, -2)}`,
      'not a cursor at all',
    ]) {
      const response = await carry(SITE_LOG, forged);
      expectFailure(response, 400, 'INVALID_CURSOR');
      expect(response.body).not.toContain('v_');
    }
    expect(await stored(SITE_SCOPE, 'read:audit')).toHaveLength(1);
    // The real one works.
    expect((await carry(SITE_LOG, next)).statusCode).toBe(200);
  });

  it('is for the log it was given out for', async () => {
    expectFailure(await carry(TEAM_LOG, next), 400, 'INVALID_CURSOR');
    expectFailure(await carry(SIBLING_LOG, next), 400, 'INVALID_CURSOR');
  });

  it('is for whoever opened the listing: a colleague cannot carry on from it unrecorded', async () => {
    const second = await member('second@test.example', 'owner', true);
    expectFailure(await carry(SITE_LOG, next, { cookie: second.cookie }), 400, 'INVALID_CURSOR');
    expectFailure(
      await carry(SITE_LOG, next, { authorization: await harness.key(['admin', 'read:identity']) }),
      400,
      'INVALID_CURSOR',
    );
  });

  it('is for what was asked: an opening recorded as one question is not carried on as another', async () => {
    expectFailure(await carry(`${SITE_LOG}?target=v_7`, next), 400, 'INVALID_CURSOR');
    expectFailure(await carry(`${SITE_LOG}?kind=identity`, next), 400, 'INVALID_CURSOR');
    expectFailure(await carry(`${SITE_LOG}?actor=${harness.owner.userId}`, next), 400, 'INVALID_CURSOR');
    expectFailure(await carry(`${SITE_LOG}?from=1`, next), 400, 'INVALID_CURSOR');
    expectFailure(await carry(`${SITE_LOG}?to=${NOW}`, next), 400, 'INVALID_CURSOR');
    // How many rows a page holds is not part of the question.
    const smaller = await carry(`${SITE_LOG}?limit=5`, next);
    expect(envelope<Page>(smaller.body).data?.rows).toHaveLength(5);
  });

  it('lasts an hour from the opening, however many pages were read on the way', async () => {
    // A millisecond short of the hour it still carries on, and the cursor that
    // page gives is still the same listing's: it expires with it.
    harness.setNow(NOW + MINUTE + AUDIT_LISTING_MS - 1);
    const late = await carry(`${SITE_LOG}?limit=10`, next);
    expect(late.statusCode).toBe(200);
    const later = envelope<Page>(late.body).data?.next ?? '';

    harness.setNow(NOW + MINUTE + AUDIT_LISTING_MS);
    expectFailure(await carry(SITE_LOG, next), 400, 'CURSOR_EXPIRED');
    expectFailure(await carry(`${SITE_LOG}?limit=10`, later), 400, 'CURSOR_EXPIRED');
    // Opening it again is the way on, and that is recorded.
    expect((await read(SITE_LOG, asOwner())).statusCode).toBe(200);
    expect(await stored(SITE_SCOPE, 'read:audit')).toHaveLength(2);
  });
});

describe('asking the log for part of itself', () => {
  let keyId: string;
  let authorization: string;

  beforeEach(async () => {
    authorization = await harness.key(['admin', 'read:identity']);
    keyId = (await harness.store.apiKeys(SITE_ID))[0]?.id ?? '';
    await harness.store.audit(looked({ ts: NOW - 5000, target: 'v_ada' }));
    await harness.store.audit(looked({ ts: NOW - 4000, target: 'v_grace' }));
    await harness.store.audit(
      looked({ ts: NOW - 3000, target: 'v_ada', actor: { kind: 'key', id: keyId } }),
    );
    await harness.store.audit(
      looked({ ts: NOW - 2000, action: 'invite:create', target: 'ada@test.example', fields: ['role: viewer'] }),
    );
    await harness.store.audit(looked({ ts: NOW - 1000, action: 'read:audit', fields: [] }));
  });

  const targets = async (query: string) =>
    (await page(`${SITE_LOG}?${query}`, { authorization })).rows.map((row) => `${row.action} ${row.target ?? ''}`);

  it('by when, from an instant up to and not including another', async () => {
    expect(await targets(`from=${NOW - 4000}&to=${NOW - 2000}`)).toEqual([
      'read:identity v_ada',
      'read:identity v_grace',
    ]);
    expect(await targets(`to=${NOW - 4000}`)).toEqual(['read:identity v_ada']);
    expectFailure(
      await read(`${SITE_LOG}?from=${NOW}&to=${NOW}`, { authorization }),
      400,
      'INVALID_AUDIT_QUERY',
    );
  });

  it('by who acted', async () => {
    expect(await targets(`actor=${keyId}&to=${NOW}`)).toEqual(['read:identity v_ada']);
    expect(await targets(`actor=${harness.owner.userId}&to=${NOW}`)).toHaveLength(4);
    expect(await targets('actor=nobody')).toEqual([]);
  });

  it('by the kind of thing recorded', async () => {
    expect(await targets(`kind=identity&to=${NOW}`)).toHaveLength(3);
    expect(await targets(`kind=access&to=${NOW}`)).toEqual(['invite:create ada@test.example']);
    expect(await targets(`kind=log&to=${NOW}`)).toEqual(['read:audit v_somebody']);
    expectFailure(await read(`${SITE_LOG}?kind=everything`, { authorization }), 400, 'INVALID_AUDIT_QUERY');
  });

  it('by who it was about, exactly, which is the question the log is for', async () => {
    expect(await targets(`target=v_ada&to=${NOW}`)).toEqual(['read:identity v_ada', 'read:identity v_ada']);
    expect(await targets(`target=v_ada&actor=${keyId}&to=${NOW}`)).toEqual(['read:identity v_ada']);
    // Exactly: a beginning of an id is somebody else.
    expect(await targets('target=v_ad')).toEqual([]);
  });

  it('takes a filter left empty as no filter', async () => {
    expect(await targets(`actor=&target=&to=${NOW}`)).toHaveLength(5);
  });
});

// Condition C. The log is made of exactly what the identity gate exists for,
// so a caller who may read the log and may not read who visitors are sees the
// log with who it is about taken out. The only such caller is a key: a person
// with admin is an owner, and an owner holds read:identity.
describe('read without read:identity', () => {
  const VISITOR = 'v_ada_lovelace';
  const USER = 'ada-user-42';
  const INVITED = 'grace@invited.example';
  let viewer: Person;
  let invitation: { id: string; token: string };

  function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
    return {
      siteId: SITE_ID,
      ts: NOW - 60 * MINUTE,
      receivedAt: NOW - 60 * MINUTE,
      type: 'pageview',
      visitorId: VISITOR,
      path: '/pricing',
      hostname: 'test.example',
      bot: false,
      ip: '203.0.113.7',
      ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
      geo: { country: 'BD', city: 'Dhaka' },
      ...overrides,
    };
  }

  // Every kind of row, each written by the route that writes it.
  beforeEach(async () => {
    await harness.store.ingest([
      event(),
      event({ type: 'identify', userId: USER, traits: { plan: 'pro' } }),
    ]);
    viewer = await member('viewer@test.example', 'viewer');
    const site = `/api/sites/${SITE_ID}`;
    // Somebody looked at a visitor, at a named person, and searched for one.
    expect((await read(`${site}/visitors/${VISITOR}`, asOwner())).statusCode).toBe(200);
    expect((await read(`${site}/users/${USER}`, asOwner())).statusCode).toBe(200);
    expect((await read(`${site}/people?q=${USER}`, asOwner())).statusCode).toBe(200);
    // Somebody was invited, and somebody was given a role on the site.
    invitation = await invite(`${site}/invitations`, INVITED);
    const set = await harness.app.inject({
      method: 'PUT',
      url: `${site}/members/${viewer.userId}`,
      headers: asOwner(),
      payload: { role: 'editor', identity: false },
    });
    expect(set.statusCode).toBe(200);
    harness.setNow(harness.now() + MINUTE);
  });

  it('shows every row with who it is about taken out, whatever the row is', async () => {
    const whole = await page(SITE_LOG);
    expect(whole.rows.map((row) => row.action).sort()).toEqual([
      'invite:create',
      'member:set',
      'read:identity',
      'read:identity',
      'read:identity',
    ]);
    // What the owner sees is what there is to hide.
    expect(whole.rows.map((row) => row.target).sort()).toEqual(
      [INVITED, USER, USER, VISITOR, viewer.userId].sort(),
    );
    expect(whole.rows.every((row) => row.actor.email === OWNER_EMAIL)).toBe(true);
    expect(whole.accounts[harness.owner.userId]?.email).toBe(OWNER_EMAIL);

    const authorization = await harness.key(['admin']);
    const response = await read(`${SITE_LOG}?to=${harness.now()}`, { authorization });
    expect(response.statusCode).toBe(200);
    const body = envelope<Page>(response.body);
    expect(body.meta).toEqual({ identity: false, limit: 50 });
    const rows = body.data?.rows ?? [];
    // The same rows: when, what, by which account, through which route, what
    // changed.
    expect(rows.map((row) => [row.id, row.ts, row.action, row.route, row.actor.id, row.fields])).toEqual(
      whole.rows.map((row) => [row.id, row.ts, row.action, row.route, row.actor.id, row.fields]),
    );
    // And nothing that says who anybody is.
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('target');
      expect(row.actor).toEqual({ kind: 'session', id: harness.owner.userId });
    }
    expect(body.data?.accounts).toEqual({});
    for (const personal of [VISITOR, USER, INVITED, OWNER_EMAIL, 'viewer@test.example', '@']) {
      expect(response.body).not.toContain(personal);
    }
  });

  it('refuses to be asked about one target, before anything is read or recorded', async () => {
    const authorization = await harness.key(['admin']);
    const response = await read(`${SITE_LOG}?target=${VISITOR}`, { authorization });
    expectFailure(response, 403, 'SCOPE_REQUIRED');
    expect(await stored(SITE_SCOPE, 'read:audit')).toEqual([]);
    // With the scope the same question is answered.
    const allowed = await harness.key(['admin', 'read:identity']);
    expect((await page(`${SITE_LOG}?target=${VISITOR}`, { authorization: allowed })).rows).toHaveLength(1);
  });

  it('records the opening all the same, as having carried nothing personal', async () => {
    const authorization = await harness.key(['admin']);
    await page(SITE_LOG, { authorization });
    const [row] = await stored(SITE_SCOPE, 'read:audit');
    expect(row).toMatchObject({ action: 'read:audit', fields: [] });
    expect(row?.actor.kind).toBe('key');
    expect(row?.target).toBeUndefined();
  });

  it('shows all of it to a key that holds both scopes', async () => {
    const authorization = await harness.key(['admin', 'read:identity']);
    const response = await read(`${SITE_LOG}?to=${harness.now()}`, { authorization });
    const body = envelope<Page>(response.body);
    expect(body.meta).toEqual({ identity: true, limit: 50 });
    expect(body.data?.rows.map((row) => row.target).sort()).toEqual(
      [INVITED, USER, USER, VISITOR, viewer.userId].sort(),
    );
    expect(body.data?.rows[0]?.actor.email).toBe(OWNER_EMAIL);
  });

  // The id of whoever acted is this install's own for an account made here,
  // and says nothing. For an account another application signs in it is that
  // application's name for the person, and here that name is an address.
  it('puts a stand-in where whoever acted is somebody another application signs in, and is not asked about one', async () => {
    const sub = 'ada.lovelace@corp.example';
    harness.setNow(harness.now() + MINUTE);
    const arrived = await harness.app.inject({
      method: 'GET',
      url: `/api/sso?token=${signHs256(
        'test-sso-secret-not-a-real-key-000000',
        ssoClaimsFor({
          sub,
          email: 'ada@mail.corp.example',
          teamId: TEAM_ID,
          role: 'viewer',
          identity: true,
          now: harness.now(),
          lifetimeSeconds: 300,
        }),
      )}`,
    });
    expect(arrived.statusCode).toBe(303);
    const theirs = { cookie: `${arrived.cookies[0]?.name}=${arrived.cookies[0]?.value}` };
    // They look at a visitor and at a named person: two rows by one account.
    const site = `/api/sites/${SITE_ID}`;
    expect((await read(`${site}/visitors/${VISITOR}`, theirs)).statusCode).toBe(200);
    expect((await read(`${site}/users/${USER}`, theirs)).statusCode).toBe(200);
    harness.setNow(harness.now() + MINUTE);

    // What there is to hide: the owner sees the id as it is.
    const whole = await page(`${SITE_LOG}?actor=${encodeURIComponent(`sso_${sub}`)}`);
    expect(whole.rows.map((row) => row.actor.id)).toEqual([`sso_${sub}`, `sso_${sub}`]);

    const authorization = await harness.key(['admin']);
    const response = await read(`${SITE_LOG}?to=${harness.now()}`, { authorization });
    expect(response.statusCode).toBe(200);
    for (const personal of [sub, 'corp.example', 'ada.lovelace', 'ada@mail']) {
      expect(response.body).not.toContain(personal);
    }
    const rows = envelope<Page>(response.body).data?.rows ?? [];
    const standIns = rows.map((row) => row.actor.id).filter((id) => id.startsWith('sso~'));
    // Both rows, and the same stand-in on both: still one somebody.
    expect(standIns).toHaveLength(2);
    expect(new Set(standIns).size).toBe(1);
    expect(standIns[0]).toMatch(/^sso~[A-Za-z0-9_-]{22}$/);
    // The owner's id, which this install made, is as it was.
    expect(rows.some((row) => row.actor.id === harness.owner.userId)).toBe(true);
    // The same account is the same stand-in on another read, and another page.
    const again = await read(`${SITE_LOG}?to=${harness.now()}&limit=1`, { authorization });
    const second = await read(`${SITE_LOG}?to=${harness.now() + 1}`, { authorization });
    expect(envelope<Page>(again.body).data?.rows[0]?.actor.id).toBe(standIns[0]);
    expect(second.body).toContain(standIns[0]);

    // Asking the log about that account names a person: refused before the
    // store is asked, and not recorded as an opening.
    const opened = (await stored(SITE_SCOPE, 'read:audit')).length;
    const asked = await read(`${SITE_LOG}?actor=${encodeURIComponent(`sso_${sub}`)}`, { authorization });
    expectFailure(asked, 403, 'SCOPE_REQUIRED');
    expect(await stored(SITE_SCOPE, 'read:audit')).toHaveLength(opened);
    // An account this install made, and a key, can be asked about.
    expect((await read(`${SITE_LOG}?actor=${harness.owner.userId}`, { authorization })).statusCode).toBe(200);
    // And with the scope, so can that one.
    const both = await harness.key(['admin', 'read:identity']);
    const seen = await read(`${SITE_LOG}?actor=${encodeURIComponent(`sso_${sub}`)}`, { authorization: both });
    expect(envelope<Page>(seen.body).data?.rows).toHaveLength(2);
  });

  it('holds nothing an invitation link is made of, for any reader', async () => {
    const hash = createHash('sha256').update(invitation.token).digest('hex');
    const team = await invite(`/api/teams/${TEAM_ID}/invitations`, 'team@invited.example');
    const teamHash = createHash('sha256').update(team.token).digest('hex');
    for (const body of [(await read(SITE_LOG, asOwner())).body, (await read(TEAM_LOG, asOwner())).body]) {
      for (const secret of [invitation.token, hash, team.token, teamHash, 'tokenHash', 'password']) {
        expect(body).not.toContain(secret);
      }
    }
    // The invitation is named, by its id.
    expect((await read(SITE_LOG, asOwner())).body).toContain(`invitation ${invitation.id}`);
  });
});

describe('the accounts a page names', () => {
  it('are looked up once and given beside the rows: who acted, and who access was changed for', async () => {
    const viewer = await member('viewer@test.example', 'viewer');
    const bystander = await member('bystander@test.example', 'viewer');
    await harness.app.inject({
      method: 'PUT',
      url: `/api/sites/${SITE_ID}/members/${viewer.userId}`,
      headers: asOwner(),
      payload: { role: 'editor', identity: false },
    });
    const authorization = await harness.key(['admin', 'read:identity']);
    const keyId = (await harness.store.apiKeys(SITE_ID))[0]?.id ?? '';
    await harness.store.audit(looked({ ts: harness.now(), actor: { kind: 'key', id: keyId } }));
    // A read about a visitor whose id happens to be an account's id here. A
    // visitor of the site is not an account of this install, and the page does
    // not guess that it is.
    await harness.store.audit(looked({ ts: harness.now(), target: bystander.userId }));

    let lookups = 0;
    const usersByIds = harness.store.usersByIds.bind(harness.store);
    harness.store.usersByIds = (ids: string[]) => {
      lookups += 1;
      return usersByIds(ids);
    };
    const answer = await page(SITE_LOG, { authorization });
    harness.store.usersByIds = usersByIds;

    expect(lookups).toBe(1);
    expect(answer.accounts).toEqual({
      [harness.owner.userId]: { email: OWNER_EMAIL },
      [viewer.userId]: { email: 'viewer@test.example' },
    });
  });
});

describe('the two logs', () => {
  it('each hold their own rows: what happened to a site, and what happened to the team', async () => {
    const toTeam = await invite(`/api/teams/${TEAM_ID}/invitations`, 'team@invited.example');
    const toSite = await invite(`/api/sites/${SITE_ID}/invitations`, 'site@invited.example');
    const toSibling = await invite(`/api/sites/${SIBLING}/invitations`, 'sibling@invited.example');

    const said = async (url: string) => (await page(url)).rows.map((row) => row.fields[0]);
    expect(await said(TEAM_LOG)).toEqual([`invitation ${toTeam.id}`]);
    expect(await said(SITE_LOG)).toEqual([`invitation ${toSite.id}`]);
    expect(await said(SIBLING_LOG)).toEqual([`invitation ${toSibling.id}`]);
  });
});
