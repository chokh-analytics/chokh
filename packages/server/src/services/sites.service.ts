import { randomBytes, randomUUID } from 'node:crypto';

import { teamIdOf, type Principal } from '../lib/scopes.js';
import type {
  AccountStore,
  AnalyticsStore,
  Role,
  Scope,
  Site,
  SitePatch,
  SiteSettings,
} from '../store/AnalyticsStore.js';
import { defaultSiteSettings } from '../store/AnalyticsStore.js';

// Creating and changing a site.
//
// Two things here are not obvious. A site is created with an identifySecret
// already in it, because an application that wants to prove who its visitors are
// needs one and there is nowhere else to get it; it is returned once, in the
// create response, and afterwards only a rotation can produce it again. And the
// secret is stripped from every read, because a secret a GET hands back is a
// secret in a browser's cache, a proxy log and a screenshot.

export function newIdentifySecret(): string {
  return randomBytes(32).toString('base64url');
}

export interface SiteDraft {
  // Chosen by the caller, because it is the data-site attribute that goes in a
  // page and a person has to be able to read it. Generated when they do not care.
  id?: string;
  name: string;
  domains: string[];
  teamId: string;
  settings?: Partial<SiteSettings>;
}

export interface SiteWithSecret {
  site: Site;
  // The only time it is ever returned.
  identifySecret: string;
}

export async function createSite(store: AccountStore, draft: SiteDraft): Promise<SiteWithSecret> {
  const identifySecret = newIdentifySecret();
  const site: Site = {
    id: draft.id ?? `s_${randomUUID().slice(0, 8)}`,
    name: draft.name,
    domains: draft.domains,
    teamId: draft.teamId,
    settings: defaultSiteSettings({ ...draft.settings, identifySecret }),
  };
  await store.createSite(site);
  return { site, identifySecret };
}

export function updateSite(store: AccountStore, siteId: string, patch: SitePatch): Promise<Site> {
  return store.updateSite(siteId, patch);
}

// A new secret, returned once. Every signature issued under the old one stops
// verifying the moment this lands, so an application rotates it and deploys the
// new value together; a site that only accepts signed identifies will refuse
// them in between, which is the safe direction to fail.
export async function rotateIdentifySecret(
  store: AccountStore,
  siteId: string,
): Promise<SiteWithSecret> {
  const identifySecret = newIdentifySecret();
  const site = await store.updateSite(siteId, { settings: { identifySecret } });
  return { site, identifySecret };
}

export type PublicSiteSettings = Omit<SiteSettings, 'identifySecret'>;

export interface PublicSite {
  id: string;
  name: string;
  domains: string[];
  teamId: string;
  settings: PublicSiteSettings;
}

// A site as it appears in GET /api/me and GET /api/sites: what it is, plus what
// the caller may do to it, so a dashboard knows which tabs to draw without
// guessing from a 403.
export interface VisibleSite extends PublicSite {
  scopes: Scope[];
  role?: Role;
}

export async function visibleSites(
  store: AnalyticsStore,
  principal: Principal,
): Promise<VisibleSite[]> {
  const found: VisibleSite[] = [];
  for (const site of await store.sites()) {
    const grant = principal.grantFor(site);
    if (grant === null) {
      continue;
    }
    found.push({
      ...publicSite(site),
      scopes: [...grant.scopes].sort(),
      ...(grant.role === undefined ? {} : { role: grant.role }),
    });
  }
  return found.sort((left, right) => left.id.localeCompare(right.id));
}

// A site as a route may answer with it. The identifySecret never goes out this
// way, however convenient it would be: it is the one field that lets a holder
// claim to be any user of the site.
export function publicSite(site: Site): PublicSite {
  const { identifySecret: _identifySecret, ...settings } = site.settings;
  return {
    id: site.id,
    name: site.name,
    domains: site.domains,
    teamId: teamIdOf(site),
    settings,
  };
}
