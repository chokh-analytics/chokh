import type { AuditRecord, StoredApiKey, StoredTeam, StoredUser, TeamMember } from './accounts.js';
import type {
  Alert,
  AlertFiring,
  AlertState,
  Annotation,
  Digest,
  DigestSend,
  Funnel,
  Goal,
  Segment,
} from './query.js';
import type { Site, SiteSettings, SiteShare } from './types.js';

// The second door to storage, beside AnalyticsStore.
//
// AnalyticsStore answers questions about visitors. This answers questions about
// the people reading it: the sites, the accounts, the teams, the keys and the
// audit log. They are separate interfaces because they are separate jobs and a
// reporting adapter should not have to grow a user table to exist, and they are
// implemented on one object because one deployment has one database.
//
// Every adapter is held to the same answers by runAccountConformance in
// ./conformance, the way AnalyticsStore is held by runStoreConformance.
export interface AccountStore {
  // Register a site. Refuses a duplicate id with SITE_EXISTS and a domain
  // already claimed by another site with DOMAIN_TAKEN, and refuses an empty
  // domain list with DOMAIN_REQUIRED: sites.domains is a unique multikey index,
  // so an empty array stores one null key and the second domainless site would
  // collide with the first. A site with no domain could not pass the collector's
  // origin check anyway.
  createSite(site: Site): Promise<void>;

  // Change a site in place and answer with what it now is. The same domain
  // rules apply, and settings are merged field by field so a patch naming one
  // setting does not reset the rest.
  updateSite(siteId: string, patch: SitePatch): Promise<Site>;
  // The site whose public share carries this token, or null. One site per
  // token: the adapter's index says so.
  siteByShareToken(token: string): Promise<Site | null>;

  createUser(user: StoredUser): Promise<void>;
  updateUser(userId: string, patch: UserPatch): Promise<void>;
  userById(userId: string): Promise<StoredUser | null>;
  userByEmail(email: string): Promise<StoredUser | null>;
  // Whether anybody has registered yet, which is how the first account is
  // allowed to create itself and every one after it is not.
  userCount(): Promise<number>;

  createTeam(team: StoredTeam): Promise<void>;
  team(teamId: string): Promise<StoredTeam | null>;
  teamsForUser(userId: string): Promise<StoredTeam[]>;
  // Add a member or change their role. Answers with the team as it now is.
  setTeamMember(teamId: string, member: TeamMember): Promise<StoredTeam>;

  createApiKey(key: StoredApiKey): Promise<void>;
  // The one read on the authentication path: by the hash of the presented
  // token, through a unique index.
  apiKeyByHash(keyHash: string): Promise<StoredApiKey | null>;
  // Every key of a site, without anything secret: the hash is not returned.
  apiKeys(siteId: string): Promise<ApiKeyRecord[]>;
  // False when there was no such key, so a route can answer 404 rather than
  // pretending it deleted something.
  deleteApiKey(siteId: string, keyId: string): Promise<boolean>;

  // A site's goals, oldest first. Configuration and not analytics: a goal is
  // a question the reports ask of the raw events, so nothing here is counted
  // and a retention purge never touches one.
  goals(siteId: string): Promise<Goal[]>;
  goal(siteId: string, goalId: string): Promise<Goal | null>;
  // Refuses a site nobody registered with UNKNOWN_SITE, a goal asking what
  // another already asks with GOAL_EXISTS (the id is derived from the question,
  // so the unique index is what refuses it), and one more than
  // MAX_GOALS_PER_SITE with GOAL_LIMIT.
  createGoal(goal: Goal): Promise<void>;
  // False when there was no such goal on this site, so a route can answer 404.
  deleteGoal(siteId: string, goalId: string): Promise<boolean>;

  // A site's funnels, oldest first. Configuration, like goals: a funnel is a
  // question the reports ask of the raw events, so a purge never touches one.
  funnels(siteId: string): Promise<Funnel[]>;
  funnel(siteId: string, funnelId: string): Promise<Funnel | null>;
  // Refuses a site nobody registered with UNKNOWN_SITE, the same steps and
  // window asked again with FUNNEL_EXISTS (the id is derived from them, so the
  // unique index refuses it), and one more than MAX_FUNNELS_PER_SITE with
  // FUNNEL_LIMIT. How many steps a funnel has is checked where it is built.
  createFunnel(funnel: Funnel): Promise<void>;
  // False when there was no such funnel on this site, so a route can answer 404.
  deleteFunnel(siteId: string, funnelId: string): Promise<boolean>;

  // A site's segments, by name. Configuration, like goals: a segment is a
  // saved filter list, applied by sending it to a report, so nothing is
  // counted and a purge never touches one.
  segments(siteId: string): Promise<Segment[]>;
  segment(siteId: string, segmentId: string): Promise<Segment | null>;
  // Refuses a site nobody registered with UNKNOWN_SITE, the same filters saved
  // again with SEGMENT_EXISTS (the id is derived from them, so the unique
  // index refuses it), and one more than MAX_SEGMENTS_PER_SITE with
  // SEGMENT_LIMIT.
  createSegment(segment: Segment): Promise<void>;
  // False when there was no such segment on this site, so a route can answer 404.
  deleteSegment(siteId: string, segmentId: string): Promise<boolean>;

  // A site's annotations with `at` inside [from, to), oldest first. Read for
  // the range a chart draws, so a mark lands beside the point it explains.
  annotations(siteId: string, from: number, to: number): Promise<Annotation[]>;
  annotation(siteId: string, annotationId: string): Promise<Annotation | null>;
  // Refuses a site nobody registered with UNKNOWN_SITE, the same fact stated
  // again with ANNOTATION_EXISTS (the id is derived from it, so the unique
  // index refuses it), and one more than MAX_ANNOTATIONS_PER_SITE with
  // ANNOTATION_LIMIT.
  createAnnotation(annotation: Annotation): Promise<void>;
  // False when there was no such annotation on this site, so a route can
  // answer 404.
  deleteAnnotation(siteId: string, annotationId: string): Promise<boolean>;

  // A site's alerts, by name. The rows only: what evaluates them and sends
  // their messages is packages/ee, and a core-only install writes none.
  alerts(siteId: string): Promise<Alert[]>;
  alert(siteId: string, alertId: string): Promise<Alert | null>;
  // Refuses a site nobody registered with UNKNOWN_SITE, the same question
  // asked again with ALERT_EXISTS (the id is derived from it, so the unique
  // index refuses it), and one more than MAX_ALERTS_PER_SITE with ALERT_LIMIT.
  createAlert(alert: Alert): Promise<void>;
  // False when there was no such alert on this site, so a route can answer 404.
  deleteAlert(siteId: string, alertId: string): Promise<boolean>;
  // Claim one bucket of one alert for the caller: true when the row's
  // checkedBucket was absent or older than `bucket`, which it now is set to;
  // false when another process already claimed this bucket or a newer one.
  // One write, compared and set together, so two processes ticking at once
  // evaluate each bucket once between them. False for a row that is not there.
  claimAlertCheck(siteId: string, alertId: string, bucket: number): Promise<boolean>;

  // Digests (AN-RPT01): one per cadence per site. The claim is the same idea
  // as an alert's bucket: one write that says "this period is mine", refused
  // when the row already claimed it or a later one, so every process may tick
  // and each period is sent once.
  digests(siteId: string): Promise<Digest[]>;
  digest(siteId: string, digestId: string): Promise<Digest | null>;
  createDigest(digest: Digest): Promise<void>;
  deleteDigest(siteId: string, digestId: string): Promise<boolean>;
  claimDigestSend(siteId: string, digestId: string, period: string): Promise<boolean>;
  recordDigestSend(siteId: string, digestId: string, send: DigestSend): Promise<boolean>;
  // Write what the evaluation decided: the episode state, and the transition
  // when there was one, kept as the last MAX_ALERT_RECENT of them. The
  // claimed bucket is left as it is. False for a row that is not there.
  recordAlertState(
    siteId: string,
    alertId: string,
    state: Pick<AlertState, 'firing' | 'since'>,
    firing?: AlertFiring,
  ): Promise<boolean>;

  audit(row: AuditRecord): Promise<void>;
  // The trail for a site over a range, oldest first. Read by tests today and by
  // whichever ticket gives a site owner somewhere to look at it.
  auditTrail(siteId: string, from: number, to: number): Promise<AuditRecord[]>;
}

export interface SitePatch {
  name?: string;
  domains?: string[];
  teamId?: string;
  settings?: Partial<SiteSettings>;
  // The public share: a share to keep, or null to take it off.
  share?: SiteShare | null;
}

export interface UserPatch {
  name?: string;
  passwordHash?: string;
  lastLoginAt?: number;
}

// A key as a route may show it: everything but the hash, because a hash is
// still a secret and a list of them is a list of things to attack offline.
export type ApiKeyRecord = Omit<StoredApiKey, 'keyHash'>;
