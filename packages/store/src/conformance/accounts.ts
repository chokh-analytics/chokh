import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccountStore } from '../AccountStore.js';
import type { AnalyticsStore } from '../AnalyticsStore.js';
import {
  DEFAULT_TEAM_ID,
  alertIdFor,
  annotationIdFor,
  digestIdFor,
  funnelIdFor,
  goalIdFor,
  segmentIdFor,
  type StoredApiKey,
  type StoredTeam,
  type StoredUser,
} from '../accounts.js';
import {
  MAX_ALERTS_PER_SITE,
  MAX_ALERT_RECENT,
  MAX_ANNOTATIONS_PER_SITE,
  MAX_FUNNELS_PER_SITE,
  MAX_GOALS_PER_SITE,
  MAX_SEGMENTS_PER_SITE,
  StoreQueryError,
  type Alert,
  type AlertCondition,
  type AlertFiring,
  type Annotation,
  type AnnotationKind,
  type Digest,
  type Filter,
  type Segment,
  type Funnel,
  type FunnelStep,
  type FunnelWindow,
  type Goal,
  type GoalKind,
} from '../query.js';
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

function goal(siteId: string, kind: GoalKind, match: string, at = NOW): Goal {
  return {
    siteId,
    id: goalIdFor(siteId, kind, match),
    name: match,
    kind,
    match,
    createdBy: 'u_1',
    createdAt: at,
  };
}

function segment(siteId: string, filters: Filter[], name: string, at = NOW): Segment {
  return {
    siteId,
    id: segmentIdFor(siteId, filters),
    name,
    filters,
    createdBy: 'u_1',
    createdAt: at,
  };
}

function funnel(
  siteId: string,
  steps: FunnelStep[],
  window: FunnelWindow = '7d',
  at = NOW,
): Funnel {
  return {
    siteId,
    id: funnelIdFor(siteId, window, steps),
    name: steps.map((step) => step.name).join(' then '),
    steps,
    window,
    createdBy: 'u_1',
    createdAt: at,
  };
}

const HOME: FunnelStep = { kind: 'page', match: '/home', name: 'Home' };
const PRICING: FunnelStep = { kind: 'page', match: '/*/pricing', name: 'Pricing' };
const SIGNUP: FunnelStep = { kind: 'event', match: 'signup', name: 'Signed up', goalId: 'g_x' };

function annotation(
  siteId: string,
  at: number,
  kind: AnnotationKind,
  text: string,
  url?: string,
): Annotation {
  return {
    siteId,
    id: annotationIdFor(siteId, at, kind, text),
    at,
    kind,
    text,
    ...(url === undefined ? {} : { url }),
    createdBy: 'u_1',
    createdAt: NOW,
  };
}

function alert(siteId: string, condition: AlertCondition, name: string, at = NOW): Alert {
  return {
    siteId,
    id: alertIdFor(siteId, condition),
    name,
    condition,
    channels: [{ kind: 'email', to: 'ops@example.test' }],
    createdBy: 'u_1',
    createdAt: at,
    state: { firing: false },
    recent: [],
  };
}

function firing(at: number, event: 'fired' | 'recovered', value: number): AlertFiring {
  return {
    at,
    event,
    value,
    baseline: null,
    deliveries: [{ channel: 'email', target: 'ops@example.test', ok: true }],
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

      it('keeps a public share on the site and finds the site by its token', async () => {
        const share = { token: 'tok_one_1234567890', createdBy: 'u_1', createdAt: NOW };
        const updated = await store.updateSite('s_one', { share });
        expect(updated.share).toEqual(share);
        expect((await store.siteByShareToken('tok_one_1234567890'))?.id).toBe('s_one');
        expect(await store.siteByShareToken('tok_nobody')).toBeNull();
        // A new token is the revocation of the old one.
        await store.updateSite('s_one', {
          share: { ...share, token: 'tok_two_1234567890', passwordHash: 'h' },
        });
        expect(await store.siteByShareToken('tok_one_1234567890')).toBeNull();
        expect((await store.siteByShareToken('tok_two_1234567890'))?.share?.passwordHash).toBe(
          'h',
        );
        // A patch of something else leaves it; null takes it off.
        expect((await store.updateSite('s_one', { name: 'One' })).share?.token).toBe(
          'tok_two_1234567890',
        );
        expect((await store.updateSite('s_one', { share: null })).share).toBeUndefined();
        expect((await store.site('s_one'))?.share).toBeUndefined();
        expect(await store.siteByShareToken('tok_two_1234567890')).toBeNull();
      });

      it('marks a site whose route rules changed, and only then', async () => {
        const changed = await store.updateSite('s_one', {
          settings: { routeGroups: ['/courses/:slug'] },
        });
        expect(typeof changed.routesChangedAt).toBe('number');
        const mark = changed.routesChangedAt;

        // The same rules again, and a patch of something else, leave the mark.
        const same = await store.updateSite('s_one', {
          settings: { routeGroups: ['/courses/:slug'] },
        });
        expect(same.routesChangedAt).toBe(mark);
        const other = await store.updateSite('s_one', { settings: { retentionDays: 45 } });
        expect(other.routesChangedAt).toBe(mark);
        expect((await store.site('s_one'))?.routesChangedAt).toBe(mark);
        expect((await store.site('s_one'))?.settings.routeGroups).toEqual(['/courses/:slug']);
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

    describe('goals', () => {
      beforeAll(async () => {
        await harness.reset();
        await store.createSite(site('s_goals', ['goals.example']));
        await store.createSite(site('s_else', ['else.example']));
      });

      it('stores a goal and reads it back by id and in the list, oldest first', async () => {
        const signup = { ...goal('s_goals', 'event', 'signup', NOW + 10), value: 5 };
        await store.createGoal(signup);
        await store.createGoal(goal('s_goals', 'page', '/*/checkout/done', NOW));

        expect(await store.goal('s_goals', signup.id)).toEqual(signup);
        const rows = await store.goals('s_goals');
        expect(rows.map((row) => row.match)).toEqual(['/*/checkout/done', 'signup']);
        expect(await store.goals('s_else')).toEqual([]);
      });

      it('refuses the same question asked twice, because the id is the question', async () => {
        const again = { ...goal('s_goals', 'event', 'signup'), name: 'Another name' };
        expect(again.id).toBe(goalIdFor('s_goals', 'event', 'signup'));
        expect(await refusal(() => store.createGoal(again))).toBe('GOAL_EXISTS');
        // The same name as a page is a different question.
        await store.createGoal(goal('s_goals', 'page', 'signup'));
        expect(await store.goals('s_goals')).toHaveLength(3);
      });

      it('refuses one goal more than a site may have', async () => {
        const have = (await store.goals('s_goals')).length;
        for (let index = have; index < MAX_GOALS_PER_SITE; index += 1) {
          await store.createGoal(goal('s_goals', 'event', `event_${index}`));
        }
        expect(await store.goals('s_goals')).toHaveLength(MAX_GOALS_PER_SITE);
        expect(
          await refusal(() => store.createGoal(goal('s_goals', 'event', 'one_too_many'))),
        ).toBe('GOAL_LIMIT');
        // Another site's allowance is its own.
        await store.createGoal(goal('s_else', 'event', 'one_too_many'));
      });

      it("deletes once and says so the second time, and never another site's", async () => {
        const id = goalIdFor('s_goals', 'event', 'signup');
        expect(await store.deleteGoal('s_else', id)).toBe(false);
        expect(await store.goal('s_goals', id)).not.toBeNull();
        expect(await store.deleteGoal('s_goals', id)).toBe(true);
        expect(await store.deleteGoal('s_goals', id)).toBe(false);
        expect(await store.goal('s_goals', id)).toBeNull();
      });

      it('refuses a goal on a site nobody registered', async () => {
        expect(await refusal(() => store.createGoal(goal('s_nobody', 'event', 'signup')))).toBe(
          'UNKNOWN_SITE',
        );
      });
    });

    describe('segments', () => {
      const MOBILE: Filter[] = [{ dim: 'device', op: 'is', value: 'mobile' }];
      const ORGANIC_BD: Filter[] = [
        { dim: 'channel', op: 'is', value: 'organic' },
        { dim: 'country', op: 'is', value: 'BD' },
      ];

      beforeAll(async () => {
        await harness.reset();
        await store.createSite(site('s_segments', ['segments.example']));
        await store.createSite(site('s_else', ['else.example']));
      });

      it('stores a segment and reads it back by id and in the list, by name', async () => {
        const mobile = segment('s_segments', MOBILE, 'Mobile', NOW + 10);
        await store.createSegment(mobile);
        await store.createSegment(segment('s_segments', ORGANIC_BD, 'Bangladesh, organic', NOW));

        expect(await store.segment('s_segments', mobile.id)).toEqual(mobile);
        const rows = await store.segments('s_segments');
        expect(rows.map((row) => row.name)).toEqual(['Bangladesh, organic', 'Mobile']);
        expect(rows[0]?.filters).toEqual(ORGANIC_BD);
        expect(await store.segments('s_else')).toEqual([]);
      });

      it('refuses the same filters saved twice, because the id is the filters', async () => {
        const again = { ...segment('s_segments', MOBILE, 'Phones') };
        expect(again.id).toBe(segmentIdFor('s_segments', MOBILE));
        expect(await refusal(() => store.createSegment(again))).toBe('SEGMENT_EXISTS');
        // The same list in another order is the same segment.
        expect(segmentIdFor('s_segments', [...ORGANIC_BD].reverse())).toBe(
          segmentIdFor('s_segments', ORGANIC_BD),
        );
        // One more filter is another question.
        await store.createSegment(
          segment('s_segments', [...MOBILE, { dim: 'bot', op: 'is', value: 'false' }], 'Humans on phones'),
        );
        expect(await store.segments('s_segments')).toHaveLength(3);
      });

      it('refuses one segment more than a site may have', async () => {
        const have = (await store.segments('s_segments')).length;
        for (let index = have; index < MAX_SEGMENTS_PER_SITE; index += 1) {
          await store.createSegment(
            segment('s_segments', [{ dim: 'page', op: 'is', value: `/${index}` }], `Page ${index}`),
          );
        }
        expect(await store.segments('s_segments')).toHaveLength(MAX_SEGMENTS_PER_SITE);
        expect(
          await refusal(() =>
            store.createSegment(segment('s_segments', [{ dim: 'page', op: 'is', value: '/more' }], 'One too many')),
          ),
        ).toBe('SEGMENT_LIMIT');
        // Another site's allowance is its own.
        await store.createSegment(segment('s_else', MOBILE, 'Mobile'));
      });

      it("deletes once and says so the second time, and never another site's", async () => {
        const id = segmentIdFor('s_segments', MOBILE);
        expect(await store.deleteSegment('s_else', id)).toBe(false);
        expect(await store.segment('s_segments', id)).not.toBeNull();
        expect(await store.deleteSegment('s_segments', id)).toBe(true);
        expect(await store.deleteSegment('s_segments', id)).toBe(false);
        expect(await store.segment('s_segments', id)).toBeNull();
      });

      it('refuses a segment on a site nobody registered', async () => {
        expect(await refusal(() => store.createSegment(segment('s_nobody', MOBILE, 'Mobile')))).toBe(
          'UNKNOWN_SITE',
        );
      });
    });

    describe('annotations', () => {
      const HOUR = 60 * 60 * 1000;

      beforeAll(async () => {
        await harness.reset();
        await store.createSite(site('s_notes', ['notes.example']));
        await store.createSite(site('s_else', ['else.example']));
      });

      it('stores an annotation and reads it back by id and in the range, oldest first', async () => {
        const deploy = annotation('s_notes', NOW - HOUR, 'deploy', 'v2.3.0', 'https://example.test/r/2.3.0');
        await store.createAnnotation(annotation('s_notes', NOW, 'note', 'Traffic looked odd'));
        await store.createAnnotation(deploy);
        await store.createAnnotation(annotation('s_notes', NOW - 3 * HOUR, 'downtime', 'Database failover'));

        expect(await store.annotation('s_notes', deploy.id)).toEqual(deploy);
        const rows = await store.annotations('s_notes', NOW - 2 * HOUR, NOW + 1);
        expect(rows.map((row) => row.text)).toEqual(['v2.3.0', 'Traffic looked odd']);
        // The range is half open: an instant at `to` is outside it.
        expect(await store.annotations('s_notes', NOW - 2 * HOUR, NOW)).toHaveLength(1);
        expect(await store.annotations('s_else', 0, NOW + 1)).toEqual([]);
      });

      it('writes a retried statement once, because the id is the fact', async () => {
        const again = annotation('s_notes', NOW - HOUR, 'deploy', 'v2.3.0');
        expect(again.id).toBe(annotationIdFor('s_notes', NOW - HOUR, 'deploy', 'v2.3.0'));
        expect(await refusal(() => store.createAnnotation(again))).toBe('ANNOTATION_EXISTS');
        // The same words a minute later, or as a note, are another fact.
        await store.createAnnotation(annotation('s_notes', NOW - HOUR + 60_000, 'deploy', 'v2.3.0'));
        await store.createAnnotation(annotation('s_notes', NOW - HOUR, 'note', 'v2.3.0'));
        expect(await store.annotations('s_notes', 0, NOW + 1)).toHaveLength(5);
      });

      it('refuses one annotation more than a site may have', async () => {
        const have = (await store.annotations('s_notes', 0, Number.MAX_SAFE_INTEGER)).length;
        for (let index = have; index < MAX_ANNOTATIONS_PER_SITE; index += 1) {
          await store.createAnnotation(annotation('s_notes', NOW + index, 'note', `Note ${index}`));
        }
        expect(await store.annotations('s_notes', 0, Number.MAX_SAFE_INTEGER)).toHaveLength(
          MAX_ANNOTATIONS_PER_SITE,
        );
        expect(
          await refusal(() => store.createAnnotation(annotation('s_notes', NOW, 'note', 'One too many'))),
        ).toBe('ANNOTATION_LIMIT');
        // Another site's allowance is its own.
        await store.createAnnotation(annotation('s_else', NOW, 'campaign', 'Launch week'));
      });

      it("deletes once and says so the second time, and never another site's", async () => {
        const id = annotationIdFor('s_notes', NOW - HOUR, 'deploy', 'v2.3.0');
        expect(await store.deleteAnnotation('s_else', id)).toBe(false);
        expect(await store.annotation('s_notes', id)).not.toBeNull();
        expect(await store.deleteAnnotation('s_notes', id)).toBe(true);
        expect(await store.deleteAnnotation('s_notes', id)).toBe(false);
        expect(await store.annotation('s_notes', id)).toBeNull();
      });

      it('refuses an annotation on a site nobody registered', async () => {
        expect(
          await refusal(() => store.createAnnotation(annotation('s_nobody', NOW, 'note', 'x'))),
        ).toBe('UNKNOWN_SITE');
      });
    });

    describe('digests', () => {
      function digest(siteId: string, cadence: Digest['cadence'], over: Partial<Digest> = {}): Digest {
        return {
          siteId,
          id: digestIdFor(siteId, cadence),
          cadence,
          to: ['ops@example.test'],
          hour: 8,
          ...(cadence === 'weekly' ? { weekday: 1 } : {}),
          createdBy: 'u_1',
          createdAt: NOW,
          ...over,
        };
      }

      beforeAll(async () => {
        await harness.reset();
        await store.createSite(site('s_digests', ['digests.example']));
        await store.createSite(site('s_else', ['else.example']));
      });

      it('keeps one digest per cadence per site and lists them by cadence', async () => {
        const weekly = digest('s_digests', 'weekly');
        await store.createDigest(weekly);
        await store.createDigest(digest('s_digests', 'daily'));
        expect(await store.digest('s_digests', weekly.id)).toEqual(weekly);
        expect((await store.digests('s_digests')).map((row) => row.cadence)).toEqual(['daily', 'weekly']);
        expect(await store.digests('s_else')).toEqual([]);
        expect(await refusal(() => store.createDigest(digest('s_digests', 'daily', { hour: 9 })))).toBe(
          'DIGEST_EXISTS',
        );
        expect(await refusal(() => store.createDigest(digest('s_nobody', 'daily')))).toBe('UNKNOWN_SITE');
      });

      it('claims each period once, never an older one, and records what was sent', async () => {
        const id = digestIdFor('s_digests', 'daily');
        expect(await store.claimDigestSend('s_digests', id, 'd:2026-09-24')).toBe(true);
        expect(await store.claimDigestSend('s_digests', id, 'd:2026-09-24')).toBe(false);
        expect(await store.claimDigestSend('s_digests', id, 'd:2026-09-23')).toBe(false);
        expect(await store.claimDigestSend('s_digests', id, 'd:2026-09-25')).toBe(true);
        expect((await store.digest('s_digests', id))?.lastPeriod).toBe('d:2026-09-25');
        expect(await store.claimDigestSend('s_else', id, 'd:2026-09-26')).toBe(false);
        expect(await store.claimDigestSend('s_digests', 'dg_nobody', 'd:2026-09-26')).toBe(false);

        const send = {
          at: NOW,
          period: 'd:2026-09-25',
          deliveries: [{ channel: 'email' as const, target: 'ops@example.test', ok: true }],
        };
        expect(await store.recordDigestSend('s_digests', id, send)).toBe(true);
        expect((await store.digest('s_digests', id))?.last).toEqual(send);
        expect(await store.recordDigestSend('s_digests', 'dg_nobody', send)).toBe(false);
      });

      it('deletes a digest and only that one', async () => {
        const id = digestIdFor('s_digests', 'daily');
        expect(await store.deleteDigest('s_else', id)).toBe(false);
        expect(await store.deleteDigest('s_digests', id)).toBe(true);
        expect(await store.deleteDigest('s_digests', id)).toBe(false);
        expect((await store.digests('s_digests')).map((row) => row.cadence)).toEqual(['weekly']);
      });
    });

    describe('alerts', () => {
      const SILENCE: AlertCondition = { kind: 'silence', minutes: 30 };
      const DROP: AlertCondition = {
        kind: 'traffic',
        metric: 'visitors',
        direction: 'down',
        percent: 50,
        minimum: 20,
      };

      beforeAll(async () => {
        await harness.reset();
        await store.createSite(site('s_alerts', ['alerts.example']));
        await store.createSite(site('s_else', ['else.example']));
      });

      it('stores an alert and reads it back by id and in the list, by name', async () => {
        const silence = alert('s_alerts', SILENCE, 'Silence', NOW + 10);
        await store.createAlert(silence);
        await store.createAlert(alert('s_alerts', DROP, 'Big drop', NOW));

        expect(await store.alert('s_alerts', silence.id)).toEqual(silence);
        const rows = await store.alerts('s_alerts');
        expect(rows.map((row) => row.name)).toEqual(['Big drop', 'Silence']);
        expect(rows[0]?.condition).toEqual(DROP);
        expect(rows[0]?.channels).toEqual([{ kind: 'email', to: 'ops@example.test' }]);
        expect(await store.alerts('s_else')).toEqual([]);
      });

      it('refuses the same question asked twice, because the id is the question', async () => {
        const again = alert('s_alerts', SILENCE, 'Quiet');
        expect(again.id).toBe(alertIdFor('s_alerts', SILENCE));
        expect(await refusal(() => store.createAlert(again))).toBe('ALERT_EXISTS');
        // The same fields in another order are the same question; another
        // number is another question.
        expect(alertIdFor('s_alerts', { minutes: 30, kind: 'silence' } as AlertCondition)).toBe(
          alertIdFor('s_alerts', SILENCE),
        );
        await store.createAlert(alert('s_alerts', { kind: 'silence', minutes: 60 }, 'An hour quiet'));
        expect(await store.alerts('s_alerts')).toHaveLength(3);
      });

      it('claims each bucket once, in order, and never for a row that is not there', async () => {
        const id = alertIdFor('s_alerts', SILENCE);
        expect(await store.claimAlertCheck('s_alerts', id, 100)).toBe(true);
        // A second process arriving for the same bucket is turned away.
        expect(await store.claimAlertCheck('s_alerts', id, 100)).toBe(false);
        // An older bucket, arriving late, is turned away too.
        expect(await store.claimAlertCheck('s_alerts', id, 99)).toBe(false);
        expect(await store.claimAlertCheck('s_alerts', id, 101)).toBe(true);
        expect((await store.alert('s_alerts', id))?.state).toEqual({ firing: false, checkedBucket: 101 });
        expect(await store.claimAlertCheck('s_else', id, 200)).toBe(false);
        expect(await store.claimAlertCheck('s_alerts', 'al_nobody', 200)).toBe(false);
      });

      it('records an episode and keeps the last twenty transitions, oldest first', async () => {
        const id = alertIdFor('s_alerts', SILENCE);
        expect(
          await store.recordAlertState('s_alerts', id, { firing: true, since: NOW }, firing(NOW, 'fired', 0)),
        ).toBe(true);
        let row = await store.alert('s_alerts', id);
        // The claimed bucket is left as it was.
        expect(row?.state).toEqual({ firing: true, since: NOW, checkedBucket: 101 });
        expect(row?.recent).toEqual([firing(NOW, 'fired', 0)]);

        // Recovered: the episode ends and since goes with it.
        expect(
          await store.recordAlertState('s_alerts', id, { firing: false }, firing(NOW + 1, 'recovered', 7)),
        ).toBe(true);
        row = await store.alert('s_alerts', id);
        expect(row?.state).toEqual({ firing: false, checkedBucket: 101 });
        expect(row?.recent.map((each) => each.event)).toEqual(['fired', 'recovered']);

        // A quiet check writes the state and no transition.
        expect(await store.recordAlertState('s_alerts', id, { firing: false })).toBe(true);
        expect((await store.alert('s_alerts', id))?.recent).toHaveLength(2);

        for (let index = 0; index < MAX_ALERT_RECENT + 5; index += 1) {
          await store.recordAlertState('s_alerts', id, { firing: true, since: NOW }, firing(NOW + 10 + index, 'fired', index));
        }
        row = await store.alert('s_alerts', id);
        expect(row?.recent).toHaveLength(MAX_ALERT_RECENT);
        expect(row?.recent[0]?.value).toBe(5);
        expect(row?.recent[MAX_ALERT_RECENT - 1]?.value).toBe(MAX_ALERT_RECENT + 4);
        expect(await store.recordAlertState('s_alerts', 'al_nobody', { firing: false })).toBe(false);
      });

      it('refuses one alert more than a site may have', async () => {
        const have = (await store.alerts('s_alerts')).length;
        for (let index = have; index < MAX_ALERTS_PER_SITE; index += 1) {
          await store.createAlert(alert('s_alerts', { kind: 'silence', minutes: 100 + index }, `Quiet ${index}`));
        }
        expect(await store.alerts('s_alerts')).toHaveLength(MAX_ALERTS_PER_SITE);
        expect(
          await refusal(() => store.createAlert(alert('s_alerts', { kind: 'silence', minutes: 999 }, 'One too many'))),
        ).toBe('ALERT_LIMIT');
        // Another site's allowance is its own.
        await store.createAlert(alert('s_else', SILENCE, 'Silence'));
      });

      it("deletes once and says so the second time, and never another site's", async () => {
        const id = alertIdFor('s_alerts', SILENCE);
        expect(await store.deleteAlert('s_else', id)).toBe(false);
        expect(await store.alert('s_alerts', id)).not.toBeNull();
        expect(await store.deleteAlert('s_alerts', id)).toBe(true);
        expect(await store.deleteAlert('s_alerts', id)).toBe(false);
        expect(await store.alert('s_alerts', id)).toBeNull();
      });

      it('refuses an alert on a site nobody registered', async () => {
        expect(await refusal(() => store.createAlert(alert('s_nobody', SILENCE, 'x')))).toBe(
          'UNKNOWN_SITE',
        );
      });
    });

    describe('funnels', () => {
      beforeAll(async () => {
        await harness.reset();
        await store.createSite(site('s_funnels', ['funnels.example']));
        await store.createSite(site('s_else', ['else.example']));
      });

      it('stores a funnel with its steps and reads it back by id and in the list, oldest first', async () => {
        const later = funnel('s_funnels', [HOME, PRICING, SIGNUP], '7d', NOW + 10);
        const earlier = funnel('s_funnels', [HOME, SIGNUP], 'visit', NOW);
        await store.createFunnel(later);
        await store.createFunnel(earlier);

        expect(await store.funnel('s_funnels', later.id)).toEqual(later);
        // The step copied from a goal keeps where it came from; a typed path has
        // no goal to name.
        const read = await store.funnel('s_funnels', later.id);
        expect(read?.steps[2]).toEqual(SIGNUP);
        expect(read?.steps[0]?.goalId).toBeUndefined();
        const rows = await store.funnels('s_funnels');
        expect(rows.map((row) => row.id)).toEqual([earlier.id, later.id]);
        expect(await store.funnels('s_else')).toEqual([]);
      });

      it('refuses the same steps in the same window twice, whatever the name', async () => {
        const again = { ...funnel('s_funnels', [HOME, PRICING, SIGNUP]), name: 'Another name' };
        expect(await refusal(() => store.createFunnel(again))).toBe('FUNNEL_EXISTS');
        // A step's provenance is not part of the question either.
        const noGoal = funnel('s_funnels', [HOME, PRICING, { ...SIGNUP, goalId: 'g_other' }]);
        expect(noGoal.id).toBe(again.id);
        expect(await refusal(() => store.createFunnel(noGoal))).toBe('FUNNEL_EXISTS');
        // Another window, or the same steps in another order, is another funnel.
        await store.createFunnel(funnel('s_funnels', [HOME, PRICING, SIGNUP], '1d'));
        await store.createFunnel(funnel('s_funnels', [PRICING, HOME, SIGNUP]));
        expect(await store.funnels('s_funnels')).toHaveLength(4);
      });

      it('refuses one funnel more than a site may have', async () => {
        const have = (await store.funnels('s_funnels')).length;
        for (let index = have; index < MAX_FUNNELS_PER_SITE; index += 1) {
          await store.createFunnel(
            funnel('s_funnels', [HOME, { kind: 'page', match: `/step/${index}`, name: 'n' }]),
          );
        }
        expect(await store.funnels('s_funnels')).toHaveLength(MAX_FUNNELS_PER_SITE);
        expect(
          await refusal(() =>
            store.createFunnel(
              funnel('s_funnels', [HOME, { kind: 'page', match: '/too/many', name: 'n' }]),
            ),
          ),
        ).toBe('FUNNEL_LIMIT');
        // A funnel the full site already has is refused as existing, not as one
        // too many, in every adapter: the same request reads the same refusal.
        expect(
          await refusal(() =>
            store.createFunnel(
              funnel('s_funnels', [HOME, { kind: 'page', match: `/step/${have}`, name: 'n' }]),
            ),
          ),
        ).toBe('FUNNEL_EXISTS');
        // Another site's allowance is its own.
        await store.createFunnel(funnel('s_else', [HOME, PRICING]));
      });

      it("deletes once and says so the second time, and never another site's", async () => {
        const id = funnelIdFor('s_funnels', '7d', [HOME, PRICING, SIGNUP]);
        expect(await store.deleteFunnel('s_else', id)).toBe(false);
        expect(await store.funnel('s_funnels', id)).not.toBeNull();
        expect(await store.deleteFunnel('s_funnels', id)).toBe(true);
        expect(await store.deleteFunnel('s_funnels', id)).toBe(false);
        expect(await store.funnel('s_funnels', id)).toBeNull();
      });

      it('refuses a funnel on a site nobody registered', async () => {
        expect(await refusal(() => store.createFunnel(funnel('s_nobody', [HOME, PRICING])))).toBe(
          'UNKNOWN_SITE',
        );
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
