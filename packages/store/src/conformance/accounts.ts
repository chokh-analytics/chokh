import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_AUDIT_PAGE,
  MAX_PENDING_INVITATIONS,
  type AccessScope,
  type AuditPageQuery,
  type StoredInvitation,
} from '../access.js';
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
  type AuditRecord,
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

const WEEK = 7 * 86_400_000;

// An invitation to one address, a viewer's unless a case says otherwise. The
// hash is spelled from the id so a case can name it; a real one is SHA-256.
function invitation(
  id: string,
  scope: AccessScope,
  email: string,
  overrides: Partial<StoredInvitation> = {},
): StoredInvitation {
  return {
    id,
    tokenHash: `hash-${id}`,
    email,
    scope,
    role: 'viewer',
    identity: false,
    invitedBy: 'u_1',
    createdAt: NOW,
    expiresAt: NOW + WEEK,
    ...overrides,
  };
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

    // AN-TEAM01 from here: who may reach what, and the log read a page at a
    // time. Every case below is new; none above was changed.

    describe('ending sessions', () => {
      beforeAll(async () => {
        await harness.reset();
        await store.createUser(user('u_1', 'first@example.com'));
        await store.createUser(user('u_2', 'second@example.com'));
        await store.createUser(user('u_3', 'third@example.com'));
      });

      it('reads the accounts behind a list of ids, and leaves out an id nobody holds', async () => {
        const found = await store.usersByIds(['u_3', 'u_nobody', 'u_1']);
        expect(found.map((row) => row.id)).toEqual(['u_1', 'u_3']);
        expect(found[0]?.email).toBe('first@example.com');
        expect(await store.usersByIds([])).toEqual([]);
      });

      it('counts the times an account was signed out everywhere, starting from none', async () => {
        expect((await store.userById('u_1'))?.sessionEpoch ?? 0).toBe(0);
        expect(await store.bumpSessionEpoch('u_1')).toBe(1);
        expect(await store.bumpSessionEpoch('u_1')).toBe(2);
        expect((await store.userById('u_1'))?.sessionEpoch).toBe(2);
        // Nobody else's moved, and a patch of something else leaves it.
        expect((await store.userById('u_2'))?.sessionEpoch ?? 0).toBe(0);
        await store.updateUser('u_1', { lastLoginAt: NOW });
        expect((await store.userById('u_1'))?.sessionEpoch).toBe(2);
        expect((await store.userByEmail('first@example.com'))?.sessionEpoch).toBe(2);
      });

      it('counts every one of several sent at once', async () => {
        const answers = await Promise.all(
          Array.from({ length: 8 }, () => store.bumpSessionEpoch('u_2')),
        );
        expect([...answers].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect((await store.userById('u_2'))?.sessionEpoch).toBe(8);
      });

      it('refuses an account nobody holds', async () => {
        expect(await refusal(() => store.bumpSessionEpoch('u_nobody'))).toBe('UNKNOWN_USER');
      });
    });

    describe('team changes', () => {
      const withoutPassword = (id: string, email: string): StoredUser => ({
        id,
        email,
        createdAt: NOW,
      });

      beforeAll(async () => {
        await harness.reset();
        await store.createUser(user('u_1', 'first@example.com'));
        await store.createUser(user('u_2', 'second@example.com'));
        await store.createUser(withoutPassword('u_3', 'third@example.com'));
        await store.createUser(withoutPassword('u_4', 'fourth@example.com'));
        await store.createTeam(team(DEFAULT_TEAM_ID, 'u_1'));
      });

      it('adds a member at the end and changes one where they stand', async () => {
        await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_2', { role: 'viewer', identity: false });
        const added = await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_3', {
          role: 'viewer',
          identity: false,
        });
        expect(added.members.map((member) => member.userId)).toEqual(['u_1', 'u_2', 'u_3']);
        const changed = await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_2', {
          role: 'editor',
          identity: true,
        });
        expect(changed.members).toEqual([
          { userId: 'u_1', role: 'owner', identity: true },
          { userId: 'u_2', role: 'editor', identity: true },
          { userId: 'u_3', role: 'viewer', identity: false },
        ]);
        expect((await store.team(DEFAULT_TEAM_ID))?.members).toEqual(changed.members);
      });

      it('takes a member out, and says so when there was nobody to take', async () => {
        const removed = await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_3', null);
        expect(removed.members.map((member) => member.userId)).toEqual(['u_1', 'u_2']);
        expect(await store.teamsForUser('u_3')).toEqual([]);
        expect(await refusal(() => store.changeTeamMember(DEFAULT_TEAM_ID, 'u_3', null))).toBe(
          'UNKNOWN_MEMBER',
        );
        expect(
          await refusal(() =>
            store.changeTeamMember('t_nothing', 'u_1', { role: 'viewer', identity: false }),
          ),
        ).toBe('UNKNOWN_TEAM');
      });

      it('refuses to lower or remove the last owner, and changes nothing', async () => {
        expect(
          await refusal(() =>
            store.changeTeamMember(DEFAULT_TEAM_ID, 'u_1', { role: 'editor', identity: true }),
          ),
        ).toBe('LAST_OWNER');
        expect(await refusal(() => store.changeTeamMember(DEFAULT_TEAM_ID, 'u_1', null))).toBe(
          'LAST_OWNER',
        );
        expect((await store.team(DEFAULT_TEAM_ID))?.members[0]).toEqual({
          userId: 'u_1',
          role: 'owner',
          identity: true,
        });
        // The owner's flag is not their role: it can be changed.
        const kept = await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_1', {
          role: 'owner',
          identity: true,
        });
        expect(kept.members[0]?.role).toBe('owner');
      });

      it('refuses to leave a team with no owner who has a password', async () => {
        // u_3 arrives through another application and has no password here.
        await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_3', { role: 'owner', identity: true });
        expect(
          await refusal(() =>
            store.changeTeamMember(DEFAULT_TEAM_ID, 'u_1', { role: 'viewer', identity: false }),
          ),
        ).toBe('LAST_OWNER');
        expect(await refusal(() => store.changeTeamMember(DEFAULT_TEAM_ID, 'u_1', null))).toBe(
          'LAST_OWNER',
        );
        // The one without a password can go: an owner with one remains.
        const lowered = await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_3', null);
        expect(lowered.members.map((member) => member.userId)).toEqual(['u_1', 'u_2']);
        // And once a second owner has a password, the first may step down.
        await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_2', { role: 'owner', identity: true });
        const stepped = await store.changeTeamMember(DEFAULT_TEAM_ID, 'u_1', {
          role: 'viewer',
          identity: false,
        });
        expect(stepped.members.find((member) => member.userId === 'u_1')?.role).toBe('viewer');
      });

      it('holds a team whose owners never had a password to the first rule only', async () => {
        await store.createTeam({
          id: 't_sso',
          name: 'Signed in elsewhere',
          members: [
            { userId: 'u_3', role: 'owner', identity: true },
            { userId: 'u_4', role: 'owner', identity: false },
          ],
        });
        const lowered = await store.changeTeamMember('t_sso', 'u_3', {
          role: 'viewer',
          identity: false,
        });
        expect(lowered.members.find((member) => member.userId === 'u_3')?.role).toBe('viewer');
        expect(await refusal(() => store.changeTeamMember('t_sso', 'u_4', null))).toBe('LAST_OWNER');
      });

      it('refuses exactly one of two owners lowering each other at the same moment', async () => {
        for (let round = 0; round < 6; round += 1) {
          const id = `t_race_${round}`;
          await store.createTeam({
            id,
            name: id,
            members: [
              { userId: 'u_1', role: 'owner', identity: true },
              { userId: 'u_2', role: 'owner', identity: true },
            ],
          });
          const outcomes = await Promise.all([
            refusal(() => store.changeTeamMember(id, 'u_1', { role: 'viewer', identity: false })),
            refusal(() => store.changeTeamMember(id, 'u_2', { role: 'viewer', identity: false })),
          ]);
          expect([...outcomes].sort()).toEqual(['LAST_OWNER', 'NOTHING_WAS_REFUSED']);
          const owners = (await store.team(id))?.members.filter((member) => member.role === 'owner');
          expect(owners).toHaveLength(1);
        }
      });

      it('keeps every one of several changes made to one team at once', async () => {
        await store.createTeam({
          id: 't_busy',
          name: 'Busy',
          members: [{ userId: 'u_1', role: 'owner', identity: true }],
        });
        const ids = ['u_a', 'u_b', 'u_c', 'u_d', 'u_e'];
        await Promise.all([
          ...ids.map((userId) =>
            store.changeTeamMember('t_busy', userId, { role: 'viewer', identity: false }),
          ),
          store.setTeamMember('t_busy', { userId: 'u_f', role: 'editor', identity: false }),
        ]);
        const members = (await store.team('t_busy'))?.members ?? [];
        expect(members.map((member) => member.userId).sort()).toEqual([
          'u_1',
          'u_a',
          'u_b',
          'u_c',
          'u_d',
          'u_e',
          'u_f',
        ]);
      });

      it('renames a team and leaves its members alone', async () => {
        const renamed = await store.renameTeam('t_busy', 'Quieter now');
        expect(renamed.name).toBe('Quieter now');
        expect(renamed.members).toHaveLength(7);
        expect((await store.team('t_busy'))?.name).toBe('Quieter now');
        expect(await refusal(() => store.renameTeam('t_nothing', 'x'))).toBe('UNKNOWN_TEAM');
      });

      it('deletes a team that holds no site, and never the default one', async () => {
        await store.createSite(site('s_held', ['held.example'], { teamId: 't_busy' }));
        expect(await refusal(() => store.deleteTeam('t_busy'))).toBe('TEAM_HAS_SITES');
        expect(await refusal(() => store.deleteTeam(DEFAULT_TEAM_ID))).toBe('DEFAULT_TEAM');
        expect(await refusal(() => store.deleteTeam('t_nothing'))).toBe('UNKNOWN_TEAM');
        // Moved to another team, the site no longer holds it.
        await store.updateSite('s_held', { teamId: DEFAULT_TEAM_ID });
        await store.createInvitation(
          invitation('inv_goes', { kind: 'team', id: 't_busy' }, 'goes@example.com'),
        );
        await store.deleteTeam('t_busy');
        expect(await store.team('t_busy')).toBeNull();
        expect(await store.teamsForUser('u_a')).toEqual([]);
        expect(await store.invitation('inv_goes')).toBeNull();
        expect((await store.team(DEFAULT_TEAM_ID))?.members.length).toBeGreaterThan(0);
      });
    });

    describe('site members', () => {
      beforeAll(async () => {
        await harness.reset();
        await store.createSite(site('s_one', ['one.example']));
        await store.createSite(site('s_two', ['two.example']));
      });

      it('keeps one role per person and site, and changes it in place', async () => {
        await store.setSiteMember({ siteId: 's_one', userId: 'u_2', role: 'viewer', identity: false });
        await store.setSiteMember({ siteId: 's_one', userId: 'u_1', role: 'owner', identity: true });
        await store.setSiteMember({ siteId: 's_one', userId: 'u_2', role: 'editor', identity: true });
        expect(await store.siteMembers('s_one')).toEqual([
          { siteId: 's_one', userId: 'u_1', role: 'owner', identity: true },
          { siteId: 's_one', userId: 'u_2', role: 'editor', identity: true },
        ]);
        expect(await store.siteMembers('s_two')).toEqual([]);
      });

      it("lists what one account holds across sites, and nobody else's", async () => {
        await store.setSiteMember({ siteId: 's_two', userId: 'u_2', role: 'viewer', identity: false });
        expect(await store.siteGrantsForUser('u_2')).toEqual([
          { siteId: 's_one', userId: 'u_2', role: 'editor', identity: true },
          { siteId: 's_two', userId: 'u_2', role: 'viewer', identity: false },
        ]);
        expect((await store.siteGrantsForUser('u_1')).map((row) => row.siteId)).toEqual(['s_one']);
        expect(await store.siteGrantsForUser('u_nobody')).toEqual([]);
      });

      it('removes once and says so the second time, and only on that site', async () => {
        expect(await store.removeSiteMember('s_one', 'u_2')).toBe(true);
        expect(await store.removeSiteMember('s_one', 'u_2')).toBe(false);
        expect(await store.removeSiteMember('s_two', 'u_1')).toBe(false);
        expect((await store.siteGrantsForUser('u_2')).map((row) => row.siteId)).toEqual(['s_two']);
      });

      it('refuses a role on a site nobody registered', async () => {
        expect(
          await refusal(() =>
            store.setSiteMember({ siteId: 's_nobody', userId: 'u_1', role: 'viewer', identity: false }),
          ),
        ).toBe('UNKNOWN_SITE');
      });

      it('keeps one row when the same person is set several times at once', async () => {
        await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            store.setSiteMember({
              siteId: 's_two',
              userId: 'u_9',
              role: index % 2 === 0 ? 'viewer' : 'editor',
              identity: false,
            }),
          ),
        );
        const rows = (await store.siteMembers('s_two')).filter((row) => row.userId === 'u_9');
        expect(rows).toHaveLength(1);
        expect(await store.siteGrantsForUser('u_9')).toHaveLength(1);
      });
    });

    describe('invitations', () => {
      const TEAM: AccessScope = { kind: 'team', id: DEFAULT_TEAM_ID };
      const SITE: AccessScope = { kind: 'site', id: 's_one' };

      beforeAll(async () => {
        await harness.reset();
        await store.createTeam(team(DEFAULT_TEAM_ID, 'u_1'));
        await store.createTeam(team('t_full', 'u_1'));
        await store.createSite(site('s_one', ['one.example']));
      });

      it('finds an invitation by the hash of its token and never hands the hash back', async () => {
        await store.createInvitation(invitation('inv_1', TEAM, 'Ada@Example.com'));
        const found = await store.invitationByHash('hash-inv_1');
        expect(found).toEqual({
          id: 'inv_1',
          email: 'ada@example.com',
          scope: TEAM,
          role: 'viewer',
          identity: false,
          invitedBy: 'u_1',
          createdAt: NOW,
          expiresAt: NOW + WEEK,
        });
        expect(found).not.toHaveProperty('tokenHash');
        expect(await store.invitation('inv_1')).toEqual(found);
        expect(await store.invitationByHash('hash-nothing')).toBeNull();
        expect(await store.invitation('inv_nothing')).toBeNull();
      });

      it("lists what is waiting on a scope, oldest first, and only that scope's", async () => {
        await store.createInvitation(
          invitation('inv_3', TEAM, 'cyd@example.com', { createdAt: NOW + 2000, expiresAt: NOW + WEEK }),
        );
        await store.createInvitation(
          invitation('inv_2', TEAM, 'bea@example.com', { createdAt: NOW + 1000, expiresAt: NOW + WEEK }),
        );
        await store.createInvitation(
          invitation('inv_site', SITE, 'ada@example.com', { role: 'editor', identity: true }),
        );
        expect((await store.openInvitations(TEAM)).map((row) => row.id)).toEqual([
          'inv_1',
          'inv_2',
          'inv_3',
        ]);
        const onSite = await store.openInvitations(SITE);
        expect(onSite.map((row) => row.id)).toEqual(['inv_site']);
        expect(onSite[0]?.role).toBe('editor');
        expect(onSite[0]?.identity).toBe(true);
        for (const row of [...onSite, ...(await store.openInvitations(TEAM))]) {
          expect(row).not.toHaveProperty('tokenHash');
        }
        expect(await store.openInvitations({ kind: 'team', id: 't_full' })).toEqual([]);
      });

      it('refuses a second invitation waiting for the same address on the same scope', async () => {
        expect(
          await refusal(() => store.createInvitation(invitation('inv_again', TEAM, 'ADA@example.com'))),
        ).toBe('INVITATION_EXISTS');
        expect(await store.invitation('inv_again')).toBeNull();
        // The same token twice is refused too, whoever it is for.
        expect(
          await refusal(() =>
            store.createInvitation({
              ...invitation('inv_same_token', TEAM, 'new@example.com'),
              tokenHash: 'hash-inv_1',
            }),
          ),
        ).toBe('INVITATION_EXISTS');
      });

      it('lets an address be invited again once the first one lapsed, and closes the first', async () => {
        await store.createInvitation(
          invitation('inv_old', TEAM, 'dee@example.com', { createdAt: NOW, expiresAt: NOW + 1000 }),
        );
        // Still waiting a moment before it lapses: refused.
        expect(
          await refusal(() =>
            store.createInvitation(
              invitation('inv_early', TEAM, 'dee@example.com', {
                createdAt: NOW + 999,
                expiresAt: NOW + WEEK,
              }),
            ),
          ),
        ).toBe('INVITATION_EXISTS');
        await store.createInvitation(
          invitation('inv_new', TEAM, 'dee@example.com', {
            createdAt: NOW + 1000,
            expiresAt: NOW + WEEK,
            invitedBy: 'u_2',
          }),
        );
        const old = await store.invitation('inv_old');
        expect(old?.revokedAt).toBe(NOW + 1000);
        expect(old?.revokedBy).toBe('u_2');
        expect((await store.openInvitations(TEAM)).map((row) => row.id)).toContain('inv_new');
        expect((await store.openInvitations(TEAM)).map((row) => row.id)).not.toContain('inv_old');
      });

      it('refuses one more than the ceiling waiting on one scope', async () => {
        const full: AccessScope = { kind: 'team', id: 't_full' };
        for (let index = 0; index < MAX_PENDING_INVITATIONS; index += 1) {
          await store.createInvitation(invitation(`inv_f${index}`, full, `p${index}@example.com`));
        }
        expect(
          await refusal(() => store.createInvitation(invitation('inv_over', full, 'over@example.com'))),
        ).toBe('INVITATION_LIMIT');
        // One used or revoked makes room, and another scope was never full.
        expect(await store.revokeInvitation('inv_f0', NOW + 5, 'u_1')).toBe(true);
        await store.createInvitation(invitation('inv_room', full, 'room@example.com'));
        expect(await store.openInvitations(full)).toHaveLength(MAX_PENDING_INVITATIONS);
      });

      it('refuses a team or a site that does not exist', async () => {
        expect(
          await refusal(() =>
            store.createInvitation(
              invitation('inv_no_team', { kind: 'team', id: 't_nothing' }, 'x@example.com'),
            ),
          ),
        ).toBe('UNKNOWN_TEAM');
        expect(
          await refusal(() =>
            store.createInvitation(
              invitation('inv_no_site', { kind: 'site', id: 's_nothing' }, 'x@example.com'),
            ),
          ),
        ).toBe('UNKNOWN_SITE');
      });

      it('refuses an invitation that is not created open, or that expires before it is made', async () => {
        const base = invitation('inv_bad', TEAM, 'bad@example.com');
        for (const bad of [
          { ...base, acceptedAt: NOW, acceptedBy: 'u_9' },
          { ...base, revokedAt: NOW },
          { ...base, expiresAt: base.createdAt },
          { ...base, tokenHash: '' },
          { ...base, email: '' },
        ]) {
          expect(await refusal(() => store.createInvitation(bad))).toBe('INVALID_INVITATION');
        }
        expect(await store.invitation('inv_bad')).toBeNull();
      });

      it('is used once: the first claim is answered and no later one is', async () => {
        const claimed = await store.claimInvitation('hash-inv_2', NOW + 5000, 'u_bea');
        expect(claimed?.id).toBe('inv_2');
        expect(claimed?.acceptedAt).toBe(NOW + 5000);
        expect(claimed?.acceptedBy).toBe('u_bea');
        expect(claimed).not.toHaveProperty('tokenHash');
        expect(await store.claimInvitation('hash-inv_2', NOW + 6000, 'u_other')).toBeNull();
        const after = await store.invitation('inv_2');
        expect(after?.acceptedBy).toBe('u_bea');
        expect(after?.acceptedAt).toBe(NOW + 5000);
        expect((await store.openInvitations(TEAM)).map((row) => row.id)).not.toContain('inv_2');
        expect(await store.claimInvitation('hash-nothing', NOW, 'u_x')).toBeNull();
        // Used, it no longer stands in the way of a new one to that address.
        await store.createInvitation(invitation('inv_2b', TEAM, 'bea@example.com'));
      });

      it('answers exactly one of eight claims sent at once', async () => {
        const answers = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            store.claimInvitation('hash-inv_3', NOW + 7000, `u_racer_${index}`),
          ),
        );
        const won = answers.filter((answer) => answer !== null);
        expect(won).toHaveLength(1);
        expect((await store.invitation('inv_3'))?.acceptedBy).toBe(won[0]?.acceptedBy);
      });

      it('is never claimed once it has expired', async () => {
        await store.createInvitation(
          invitation('inv_short', SITE, 'eve@example.com', { createdAt: NOW, expiresAt: NOW + 60_000 }),
        );
        // The instant it expires is already too late.
        expect(await store.claimInvitation('hash-inv_short', NOW + 60_000, 'u_eve')).toBeNull();
        expect(await store.claimInvitation('hash-inv_short', NOW + 90_000, 'u_eve')).toBeNull();
        expect((await store.invitation('inv_short'))?.acceptedAt).toBeUndefined();
        // A millisecond earlier it would have been.
        expect(
          (await store.claimInvitation('hash-inv_short', NOW + 59_999, 'u_eve'))?.acceptedBy,
        ).toBe('u_eve');
      });

      it('is never claimed once it is revoked, and is revoked once', async () => {
        expect(await store.revokeInvitation('inv_1', NOW + 8000, 'u_1')).toBe(true);
        expect(await store.revokeInvitation('inv_1', NOW + 9000, 'u_2')).toBe(false);
        expect(await store.claimInvitation('hash-inv_1', NOW + 9500, 'u_ada')).toBeNull();
        const row = await store.invitation('inv_1');
        expect(row?.revokedAt).toBe(NOW + 8000);
        expect(row?.revokedBy).toBe('u_1');
        expect(row?.acceptedAt).toBeUndefined();
        // An accepted one cannot be revoked afterwards, nor one that never was.
        expect(await store.revokeInvitation('inv_2', NOW + 9000, 'u_1')).toBe(false);
        expect(await store.revokeInvitation('inv_nothing', NOW, 'u_1')).toBe(false);
      });

      it('lists the open invitations one account sent, oldest first', async () => {
        const sent = await store.invitationsSentBy('u_2');
        expect(sent.map((row) => row.id)).toEqual(['inv_new']);
        const mine = (await store.invitationsSentBy('u_1')).map((row) => row.id);
        expect(mine).toContain('inv_site');
        expect(mine).toContain('inv_2b');
        // Neither the revoked one nor the accepted ones.
        expect(mine).not.toContain('inv_1');
        expect(mine).not.toContain('inv_2');
        expect(mine).not.toContain('inv_3');
        expect(await store.invitationsSentBy('u_nobody')).toEqual([]);
      });
    });

    describe('identities', () => {
      const ISSUER = 'https://login.example.test';

      beforeAll(async () => {
        await harness.reset();
        await store.createUser(user('u_1', 'first@example.com'));
        await store.createUser(user('u_2', 'second@example.com'));
        for (const id of ['u_a', 'u_b', 'u_c', 'u_d']) {
          await store.createUser(user(id, `${id}@example.com`));
        }
      });

      it('links an account to an outside identity and finds the account by it', async () => {
        await store.linkIdentity({ issuer: ISSUER, subject: 'sub-1', userId: 'u_1', linkedAt: NOW });
        expect((await store.userByIdentity(ISSUER, 'sub-1'))?.id).toBe('u_1');
        expect(await store.userByIdentity(ISSUER, 'sub-2')).toBeNull();
        // The pair, exactly: another issuer's same subject is somebody else.
        expect(await store.userByIdentity('https://other.example.test', 'sub-1')).toBeNull();
        expect(await store.userByIdentity(ISSUER, 'SUB-1')).toBeNull();
        expect(await store.identitiesForUser('u_1')).toEqual([
          { issuer: ISSUER, subject: 'sub-1', userId: 'u_1', linkedAt: NOW },
        ]);
        expect(await store.identitiesForUser('u_2')).toEqual([]);
      });

      it('refuses a pair that is already linked, to another account or to this one', async () => {
        expect(
          await refusal(() =>
            store.linkIdentity({ issuer: ISSUER, subject: 'sub-1', userId: 'u_2', linkedAt: NOW }),
          ),
        ).toBe('IDENTITY_TAKEN');
        expect(
          await refusal(() =>
            store.linkIdentity({ issuer: ISSUER, subject: 'sub-1', userId: 'u_1', linkedAt: NOW }),
          ),
        ).toBe('IDENTITY_TAKEN');
        expect((await store.userByIdentity(ISSUER, 'sub-1'))?.id).toBe('u_1');
      });

      it('refuses a second identity of one issuer on one account', async () => {
        expect(
          await refusal(() =>
            store.linkIdentity({ issuer: ISSUER, subject: 'sub-9', userId: 'u_1', linkedAt: NOW }),
          ),
        ).toBe('IDENTITY_EXISTS');
        expect(await store.userByIdentity(ISSUER, 'sub-9')).toBeNull();
        // Another issuer is another identity, and that is allowed.
        await store.linkIdentity({
          issuer: 'https://other.example.test',
          subject: 'sub-9',
          userId: 'u_1',
          linkedAt: NOW + 1,
        });
        expect((await store.identitiesForUser('u_1')).map((row) => row.issuer)).toEqual([
          ISSUER,
          'https://other.example.test',
        ]);
      });

      it('refuses an account nobody holds', async () => {
        expect(
          await refusal(() =>
            store.linkIdentity({ issuer: ISSUER, subject: 'sub-x', userId: 'u_nobody', linkedAt: NOW }),
          ),
        ).toBe('UNKNOWN_USER');
      });

      it('unlinks once and says so the second time', async () => {
        expect(await store.unlinkIdentity('u_1', 'https://other.example.test')).toBe(true);
        expect(await store.unlinkIdentity('u_1', 'https://other.example.test')).toBe(false);
        expect(await store.unlinkIdentity('u_2', ISSUER)).toBe(false);
        expect((await store.userByIdentity(ISSUER, 'sub-1'))?.id).toBe('u_1');
        // Unlinked, the pair can be linked again.
        await store.linkIdentity({
          issuer: 'https://other.example.test',
          subject: 'sub-9',
          userId: 'u_2',
          linkedAt: NOW + 2,
        });
        expect((await store.userByIdentity('https://other.example.test', 'sub-9'))?.id).toBe('u_2');
      });

      it('links a pair to one account when several ask at once', async () => {
        const outcomes = await Promise.all(
          ['u_a', 'u_b', 'u_c', 'u_d'].map((userId) =>
            refusal(() =>
              store.linkIdentity({ issuer: ISSUER, subject: 'sub-race', userId, linkedAt: NOW }),
            ),
          ),
        );
        expect(outcomes.filter((code) => code === 'NOTHING_WAS_REFUSED')).toHaveLength(1);
        expect(outcomes.filter((code) => code === 'IDENTITY_TAKEN')).toHaveLength(3);
        const holder = await store.userByIdentity(ISSUER, 'sub-race');
        expect(['u_a', 'u_b', 'u_c', 'u_d']).toContain(holder?.id);
      });
    });

    describe('the audit log, a page at a time', () => {
      const row = (
        scope: { siteId: string } | { teamId: string },
        ts: number,
        action: string,
        actorId: string,
        target?: string,
      ): AuditRecord => ({
        ...scope,
        ts,
        actor: actorId.startsWith('k_')
          ? { kind: 'key', id: actorId }
          : { kind: 'session', id: actorId, email: `${actorId}@example.com` },
        action,
        route: 'GET /api/sites/:siteId/people',
        ...(target === undefined ? {} : { target }),
        fields: action === 'read:identity' ? ['ip', 'userId'] : ['role=viewer'],
      });

      // Read every page of a query and hand back the targets in the order
      // they came, with how many pages it took.
      async function walk(
        query: Omit<AuditPageQuery, 'after'>,
      ): Promise<{ targets: (string | undefined)[]; ids: string[]; pages: number }> {
        const targets: (string | undefined)[] = [];
        const ids: string[] = [];
        let after: AuditPageQuery['after'];
        let pages = 0;
        for (;;) {
          const page = await store.auditPage(after === undefined ? query : { ...query, after });
          pages += 1;
          expect(page.rows.length).toBeLessThanOrEqual(query.limit);
          for (const each of page.rows) {
            targets.push(each.target);
            ids.push(each.id);
          }
          if (page.next === null) break;
          after = page.next;
          if (pages > 50) throw new Error('the log never ended');
        }
        return { targets, ids, pages };
      }

      beforeAll(async () => {
        await harness.reset();
        // Seven rows of one site, five of them in one millisecond, written in
        // the order t1 to t7.
        await store.audit(row({ siteId: 's_one' }, NOW, 'read:identity', 'u_1', 't1'));
        await store.audit(row({ siteId: 's_one' }, NOW + 1000, 'read:identity', 'u_1', 't2'));
        await store.audit(row({ siteId: 's_one' }, NOW + 1000, 'read:identity', 'k_1', 't3'));
        await store.audit(row({ siteId: 's_one' }, NOW + 1000, 'member:set', 'u_2', 't4'));
        await store.audit(row({ siteId: 's_one' }, NOW + 1000, 'read:identity', 'u_2', 't5'));
        await store.audit(row({ siteId: 's_one' }, NOW + 1000, 'read:audit', 'u_1', 't6'));
        await store.audit(row({ siteId: 's_one' }, NOW + 2000, 'read:identity', 'u_1', 't7'));
        await store.audit(row({ siteId: 's_two' }, NOW + 1000, 'read:identity', 'u_1', 'other'));
        await store.audit(row({ teamId: 't_1' }, NOW + 1000, 'member:set', 'u_1', 'team-1'));
        await store.audit(row({ teamId: 't_1' }, NOW + 3000, 'invite:create', 'u_1', 'team-2'));
        await store.audit(row({ teamId: 's_one' }, NOW + 1000, 'member:remove', 'u_1', 'same-name'));
      });

      it("reads a site's rows newest first, with what each row said", async () => {
        const page = await store.auditPage({ scope: { kind: 'site', id: 's_one' }, limit: 50 });
        expect(page.next).toBeNull();
        expect(page.rows).toHaveLength(7);
        expect(page.rows[0]?.target).toBe('t7');
        expect(page.rows[6]?.target).toBe('t1');
        expect(page.rows.map((each) => each.ts)).toEqual(
          [...page.rows.map((each) => each.ts)].sort((left, right) => right - left),
        );
        const first = page.rows[6];
        expect(first?.siteId).toBe('s_one');
        expect(first?.teamId).toBeUndefined();
        expect(first?.actor).toEqual({ kind: 'session', id: 'u_1', email: 'u_1@example.com' });
        expect(first?.action).toBe('read:identity');
        expect(first?.fields).toEqual(['ip', 'userId']);
        expect(typeof first?.id).toBe('string');
        expect(new Set(page.rows.map((each) => each.id)).size).toBe(7);
      });

      it('pages through rows of one millisecond without a gap or a repeat', async () => {
        const whole = await walk({ scope: { kind: 'site', id: 's_one' }, limit: 50 });
        for (const limit of [1, 2, 3, 4]) {
          const paged = await walk({ scope: { kind: 'site', id: 's_one' }, limit });
          expect(paged.ids).toEqual(whole.ids);
          expect(paged.pages).toBeGreaterThan(1);
        }
        expect(new Set(whole.ids).size).toBe(7);
        expect([...whole.targets].sort()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
      });

      it('says when a page was the last one, and when it was not', async () => {
        const exact = await store.auditPage({ scope: { kind: 'site', id: 's_one' }, limit: 7 });
        expect(exact.next).toBeNull();
        const short = await store.auditPage({ scope: { kind: 'site', id: 's_one' }, limit: 6 });
        expect(short.rows).toHaveLength(6);
        expect(short.next).toEqual({ ts: short.rows[5]?.ts, id: short.rows[5]?.id });
        expect(await store.auditPage({ scope: { kind: 'site', id: 's_empty' }, limit: 10 })).toEqual({
          rows: [],
          next: null,
        });
      });

      it('filters by the range, the actor, the action and the target', async () => {
        const site: AccessScope = { kind: 'site', id: 's_one' };
        const targetsOf = async (
          query: Omit<Partial<AuditPageQuery>, 'scope' | 'limit' | 'after'>,
        ): Promise<(string | undefined)[]> =>
          [...(await walk({ scope: site, limit: 2, ...query })).targets].sort();
        // [from, to): the first instant is in, the last is out.
        expect(await targetsOf({ from: NOW + 1000, to: NOW + 2000 })).toEqual([
          't2',
          't3',
          't4',
          't5',
          't6',
        ]);
        expect(await targetsOf({ from: NOW + 1001 })).toEqual(['t7']);
        expect(await targetsOf({ to: NOW + 1000 })).toEqual(['t1']);
        expect(await targetsOf({ actorId: 'u_2' })).toEqual(['t4', 't5']);
        expect(await targetsOf({ actorId: 'k_1' })).toEqual(['t3']);
        expect(await targetsOf({ actions: ['member:set', 'read:audit'] })).toEqual(['t4', 't6']);
        expect(await targetsOf({ actions: ['read:identity'], actorId: 'u_1' })).toEqual([
          't1',
          't2',
          't7',
        ]);
        expect(await targetsOf({ target: 't5' })).toEqual(['t5']);
        expect(await targetsOf({ target: 't' })).toEqual([]);
        expect(await targetsOf({ actions: [] })).toEqual([]);
      });

      it("keeps a site's rows out of a team's page and a team's out of a site's", async () => {
        const team = await walk({ scope: { kind: 'team', id: 't_1' }, limit: 1 });
        expect(team.targets).toEqual(['team-2', 'team-1']);
        const page = await store.auditPage({ scope: { kind: 'team', id: 't_1' }, limit: 5 });
        expect(page.rows[0]?.teamId).toBe('t_1');
        expect(page.rows[0]?.siteId).toBeUndefined();
        // A team and a site that share a name are still two logs.
        expect((await walk({ scope: { kind: 'team', id: 's_one' }, limit: 5 })).targets).toEqual([
          'same-name',
        ]);
        expect((await walk({ scope: { kind: 'site', id: 't_1' }, limit: 5 })).targets).toEqual([]);
        expect((await walk({ scope: { kind: 'site', id: 's_two' }, limit: 5 })).targets).toEqual([
          'other',
        ]);
      });

      it('leaves the trail a site had: a row about a team is not in it', async () => {
        const trail = await store.auditTrail('s_one', NOW, NOW + 5000);
        expect(trail).toHaveLength(7);
        expect(trail[0]?.target).toBe('t1');
        expect(trail.every((each) => each.siteId === 's_one')).toBe(true);
      });

      it('refuses a row about both a site and a team, or about neither', async () => {
        const base = row({ siteId: 's_three' }, NOW, 'read:identity', 'u_1', 'x');
        expect(await refusal(() => store.audit({ ...base, teamId: 't_three' }))).toBe(
          'INVALID_AUDIT_ROW',
        );
        const { siteId: _siteId, ...neither } = base;
        expect(await refusal(() => store.audit(neither))).toBe('INVALID_AUDIT_ROW');
        expect(await refusal(() => store.audit({ ...neither, siteId: '' }))).toBe('INVALID_AUDIT_ROW');
        expect((await walk({ scope: { kind: 'site', id: 's_three' }, limit: 5 })).targets).toEqual([]);
        expect((await walk({ scope: { kind: 'team', id: 't_three' }, limit: 5 })).targets).toEqual([]);
      });

      it('refuses a page size it does not serve and a cursor it did not write', async () => {
        const site: AccessScope = { kind: 'site', id: 's_one' };
        for (const limit of [0, -1, 1.5, MAX_AUDIT_PAGE + 1, Number.NaN]) {
          expect(await refusal(() => store.auditPage({ scope: site, limit }))).toBe(
            'INVALID_AUDIT_QUERY',
          );
        }
        expect((await store.auditPage({ scope: site, limit: MAX_AUDIT_PAGE })).rows).toHaveLength(7);
        for (const id of ['not-a-cursor', '', "1'; DROP TABLE audit_log; --", '$gt']) {
          expect(
            await refusal(() => store.auditPage({ scope: site, limit: 5, after: { ts: NOW, id } })),
          ).toBe('INVALID_CURSOR');
        }
        expect(
          await refusal(() =>
            store.auditPage({ scope: site, limit: 5, after: { ts: Number.NaN, id: '1' } }),
          ),
        ).toBe('INVALID_CURSOR');
      });
    });
  });
}
