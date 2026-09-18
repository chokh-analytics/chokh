import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccountStore } from '../AccountStore.js';
import type { AnalyticsStore } from '../AnalyticsStore.js';
import {
  DEFAULT_TEAM_ID,
  type StoredApiKey,
  type StoredTeam,
  type StoredUser,
} from '../accounts.js';
import { StoreQueryError } from '../query.js';
import { defaultSiteSettings, type Site } from '../types.js';

// What an adapter hands the account suite. `site` and `sites` come from
// AnalyticsStore because that is where reading a site lives; the suite needs
// them to prove that a write landed.
export interface AccountHarness {
  store: AccountStore & Pick<AnalyticsStore, 'site' | 'sites'>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

function site(id: string, domains: string[], overrides: Partial<Site> = {}): Site {
  return { id, name: id, domains, settings: defaultSiteSettings(), ...overrides };
}

function user(id: string, email: string): StoredUser {
  return { id, email, name: id, passwordHash: `hash-${id}`, createdAt: NOW };
}

function team(id: string, userId: string): StoredTeam {
  return { id, name: id, members: [{ userId, role: 'owner', identity: true }] };
}

function key(id: string, siteId: string, keyHash: string): StoredApiKey {
  return {
    id,
    siteId,
    name: id,
    keyHash,
    scopes: ['read:stats'],
    createdAt: NOW,
    createdBy: 'u_1',
  };
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof StoreQueryError) {
      return error.code;
    }
    throw error;
  }
  return 'NOTHING_WAS_REFUSED';
}

// The one suite every adapter of the control plane passes. A new adapter adds no
// tests of its own for anything covered here.
export function runAccountConformance(name: string, create: () => Promise<AccountHarness>): void {
  describe(`AccountStore conformance: ${name}`, () => {
    let harness: AccountHarness;
    let store: AccountHarness['store'];

    beforeAll(async () => {
      harness = await create();
      store = harness.store;
    });

    afterAll(async () => {
      await harness.close();
    });

    describe('sites', () => {
      beforeAll(async () => {
        await harness.reset();
      });

      it('registers a site the reporting side can then read', async () => {
        await store.createSite(site('s_one', ['one.example'], { teamId: 't_1' }));
        const found = await store.site('s_one');
        expect(found?.name).toBe('s_one');
        expect(found?.domains).toEqual(['one.example']);
        expect(found?.teamId).toBe('t_1');
        expect(found?.settings.timezone).toBe('UTC');
      });

      it('refuses a second site with the same id', async () => {
        expect(await refusal(() => store.createSite(site('s_one', ['other.example'])))).toBe(
          'SITE_EXISTS',
        );
      });

      it('refuses a domain another site already claims', async () => {
        expect(await refusal(() => store.createSite(site('s_two', ['one.example'])))).toBe(
          'DOMAIN_TAKEN',
        );
      });

      // sites.domains is a unique multikey index, so an empty array stores one
      // null key: without this rule the second domainless site collides with the
      // first, and the failure reads as a driver duplicate key error rather than
      // as the missing domain it really is.
      it('refuses a site with no domain rather than letting two of them collide', async () => {
        expect(await refusal(() => store.createSite(site('s_bare', [])))).toBe('DOMAIN_REQUIRED');
        expect(await refusal(() => store.createSite(site('s_bare_two', [])))).toBe(
          'DOMAIN_REQUIRED',
        );
        expect(await store.site('s_bare')).toBeNull();
      });

      it('merges a settings patch field by field', async () => {
        const updated = await store.updateSite('s_one', {
          name: 'One',
          settings: { ipMode: 'full', retentionDays: 90 },
        });
        expect(updated.name).toBe('One');
        expect(updated.settings.ipMode).toBe('full');
        expect(updated.settings.retentionDays).toBe(90);
        // Untouched by the patch, so still the default.
        expect(updated.settings.visitorIdMode).toBe('cookieless');
        expect((await store.site('s_one'))?.settings.ipMode).toBe('full');
      });

      it('refuses a patch that would leave a site with no domain', async () => {
        expect(await refusal(() => store.updateSite('s_one', { domains: [] }))).toBe(
          'DOMAIN_REQUIRED',
        );
      });

      it('refuses a patch to a site nobody registered', async () => {
        expect(await refusal(() => store.updateSite('s_nothing', { name: 'x' }))).toBe(
          'UNKNOWN_SITE',
        );
      });

      it('lists every site it holds', async () => {
        await store.createSite(site('s_three', ['three.example']));
        expect((await store.sites()).map((row) => row.id).sort()).toEqual(['s_one', 's_three']);
      });
    });

    describe('users', () => {
      beforeAll(async () => {
        await harness.reset();
      });

      it('has nobody before anybody registers', async () => {
        expect(await store.userCount()).toBe(0);
      });

      it('stores an account and finds it by id and by address', async () => {
        await store.createUser(user('u_1', 'first@example.com'));
        expect((await store.userById('u_1'))?.email).toBe('first@example.com');
        expect((await store.userByEmail('first@example.com'))?.id).toBe('u_1');
        expect(await store.userCount()).toBe(1);
      });

      // One address is one address however it was typed, so the adapter settles
      // the case and no route above it has to remember to.
      it('treats an address as the same address whatever its case', async () => {
        expect((await store.userByEmail('First@Example.COM'))?.id).toBe('u_1');
        expect(await refusal(() => store.createUser(user('u_2', 'FIRST@example.com')))).toBe(
          'EMAIL_EXISTS',
        );
      });

      it('answers null for somebody who never registered', async () => {
        expect(await store.userById('u_nobody')).toBeNull();
        expect(await store.userByEmail('nobody@example.com')).toBeNull();
      });

      it('patches only the fields it is given', async () => {
        await store.updateUser('u_1', { lastLoginAt: NOW });
        const found = await store.userById('u_1');
        expect(found?.lastLoginAt).toBe(NOW);
        expect(found?.name).toBe('u_1');
        expect(found?.passwordHash).toBe('hash-u_1');
      });
    });

    describe('teams', () => {
      beforeAll(async () => {
        await harness.reset();
        await store.createTeam(team(DEFAULT_TEAM_ID, 'u_1'));
      });

      it('reads a team back with its members', async () => {
        const found = await store.team(DEFAULT_TEAM_ID);
        expect(found?.members).toEqual([{ userId: 'u_1', role: 'owner', identity: true }]);
      });

      it('finds the teams somebody belongs to', async () => {
        expect((await store.teamsForUser('u_1')).map((row) => row.id)).toEqual([DEFAULT_TEAM_ID]);
        expect(await store.teamsForUser('u_2')).toEqual([]);
      });

      it('adds a member and then changes their role', async () => {
        const added = await store.setTeamMember(DEFAULT_TEAM_ID, {
          userId: 'u_2',
          role: 'viewer',
          identity: false,
        });
        expect(added.members).toHaveLength(2);
        const changed = await store.setTeamMember(DEFAULT_TEAM_ID, {
          userId: 'u_2',
          role: 'editor',
          identity: true,
        });
        expect(changed.members).toHaveLength(2);
        expect(changed.members.find((member) => member.userId === 'u_2')).toEqual({
          userId: 'u_2',
          role: 'editor',
          identity: true,
        });
        expect((await store.teamsForUser('u_2')).map((row) => row.id)).toEqual([DEFAULT_TEAM_ID]);
      });

      it('refuses a member on a team nobody created', async () => {
        expect(
          await refusal(() =>
            store.setTeamMember('t_nothing', { userId: 'u_1', role: 'owner', identity: true }),
          ),
        ).toBe('UNKNOWN_TEAM');
      });
    });

    describe('api keys', () => {
      beforeAll(async () => {
        await harness.reset();
        await store.createSite(site('s_one', ['one.example']));
      });

      it('finds a key by the hash of the token presented', async () => {
        await store.createApiKey(key('k_1', 's_one', 'hash-one'));
        const found = await store.apiKeyByHash('hash-one');
        expect(found?.id).toBe('k_1');
        expect(found?.scopes).toEqual(['read:stats']);
      });

      it('answers null for a token nobody issued', async () => {
        expect(await store.apiKeyByHash('hash-nothing')).toBeNull();
      });

      it('lists the keys of a site without handing back the hashes', async () => {
        await store.createApiKey(key('k_2', 's_one', 'hash-two'));
        const rows = await store.apiKeys('s_one');
        expect(rows.map((row) => row.id).sort()).toEqual(['k_1', 'k_2']);
        for (const row of rows) {
          expect(row).not.toHaveProperty('keyHash');
        }
      });

      it('deletes once and says so the second time', async () => {
        expect(await store.deleteApiKey('s_one', 'k_2')).toBe(true);
        expect(await store.deleteApiKey('s_one', 'k_2')).toBe(false);
        expect(await store.apiKeyByHash('hash-two')).toBeNull();
      });

      it('will not delete the key of another site', async () => {
        expect(await store.deleteApiKey('s_other', 'k_1')).toBe(false);
        expect(await store.apiKeyByHash('hash-one')).not.toBeNull();
      });
    });

    describe('audit log', () => {
      beforeAll(async () => {
        await harness.reset();
        await store.audit({
          siteId: 's_one',
          ts: NOW,
          actor: { kind: 'session', id: 'u_1', email: 'first@example.com' },
          action: 'read:identity',
          route: 'GET /api/sites/:siteId/realtime',
          fields: ['ip', 'userId'],
        });
        await store.audit({
          siteId: 's_one',
          ts: NOW + 1000,
          actor: { kind: 'key', id: 'k_1' },
          action: 'read:identity',
          route: 'GET /api/sites/:siteId/users/:userId',
          target: 'u_42',
          fields: ['userId'],
        });
        await store.audit({
          siteId: 's_two',
          ts: NOW + 2000,
          actor: { kind: 'key', id: 'k_9' },
          action: 'read:identity',
          route: 'GET /api/sites/:siteId/realtime',
          fields: ['ip'],
        });
      });

      it('keeps the trail of one site, oldest first', async () => {
        const rows = await store.auditTrail('s_one', NOW, NOW + 5000);
        expect(rows.map((row) => row.route)).toEqual([
          'GET /api/sites/:siteId/realtime',
          'GET /api/sites/:siteId/users/:userId',
        ]);
        expect(rows[0]?.actor).toEqual({
          kind: 'session',
          id: 'u_1',
          email: 'first@example.com',
        });
        expect(rows[1]?.target).toBe('u_42');
        expect(rows[1]?.fields).toEqual(['userId']);
      });

      it('leaves out what happened outside the range', async () => {
        expect(await store.auditTrail('s_one', NOW + 500, NOW + 600)).toEqual([]);
      });
    });
  });
}
