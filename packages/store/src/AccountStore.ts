import type { AuditRecord, StoredApiKey, StoredTeam, StoredUser, TeamMember } from './accounts.js';
import type { Site, SiteSettings } from './types.js';

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
}

export interface UserPatch {
  name?: string;
  passwordHash?: string;
  lastLoginAt?: number;
}

// A key as a route may show it: everything but the hash, because a hash is
// still a secret and a list of them is a list of things to attack offline.
export type ApiKeyRecord = Omit<StoredApiKey, 'keyHash'>;
