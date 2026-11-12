import {
  StoreQueryError,
  defaultSiteSettings,
  sameRouteRules,
  type Site,
  type SitePatch,
  type SiteSettings,
  type SiteShare,
} from '@chokh/store';
import type { Pool } from 'pg';

import { json, text, textArray, transaction, type Queryable } from './db.js';
import { SITES, SITE_DOMAINS } from './schema.js';

// The sites: the one table both halves of the contract read. The reporting
// side asks which site a row belongs to on every batch and every report; the
// account side registers and changes them.

// A site row is read on every ingest, for its retention and its route rules.
// It changes about never, so a short cache keeps the write path off the table
// without letting a settings change wait longer than a coffee.
const SITE_CACHE_MS = 60_000;

// Why a site cannot have an empty domain list. The contract refuses one in
// every adapter; here the reason is the second half, since nothing about a
// table of domains stops two sites from having none.
const NO_DOMAIN =
  'A site needs at least one domain: one with none could not pass the collector origin check';

interface SiteRow {
  id: string;
  name: string;
  team_id: string | null;
  settings: Partial<SiteSettings>;
  share: SiteShare | null;
  routes_changed_at: number | null;
  domains: string[] | null;
}

// The domains ride along as an array in their own order, so a site is one row
// and one round trip.
const SELECT_SITE = `
  SELECT site.id, site.name, site.team_id, site.settings, site.share, site.routes_changed_at,
         (SELECT array_agg(each.domain ORDER BY each.position)
            FROM ${SITE_DOMAINS} each WHERE each.site_id = site.id) AS domains
    FROM ${SITES} site`;

// A site row as the contract describes it, and nothing the database added.
function siteOf(row: SiteRow): Site {
  const site: Site = {
    id: row.id,
    name: row.name,
    domains: row.domains ?? [],
    // Over the defaults, so a row written before a setting existed reads it as
    // the default rather than as undefined; the row wins.
    settings: defaultSiteSettings(row.settings),
  };
  if (row.team_id !== null) site.teamId = row.team_id;
  if (row.routes_changed_at !== null) site.routesChangedAt = row.routes_changed_at;
  if (row.share !== null) site.share = row.share;
  return site;
}

export interface Sites {
  site(siteId: string): Promise<Site | null>;
  siteOrThrow(siteId: string): Promise<Site>;
  sites(): Promise<Site[]>;
  siteByShareToken(token: string): Promise<Site | null>;
  createSite(site: Site): Promise<void>;
  updateSite(siteId: string, patch: SitePatch): Promise<Site>;
  // After something outside this file changed a site's row.
  forget(siteId: string): void;
}

export function createSites(pool: Pool, now: () => number): Sites {
  const cache = new Map<string, { site: Site | null; until: number }>();

  async function read(db: Queryable, siteId: string, lock = false): Promise<Site | null> {
    const result = await db.query<SiteRow>(
      `${SELECT_SITE} WHERE site.id = $1${lock ? ' FOR UPDATE OF site' : ''}`,
      [siteId],
    );
    const row = result.rows[0];
    return row === undefined ? null : siteOf(row);
  }

  async function writeDomains(db: Queryable, siteId: string, domains: string[]): Promise<void> {
    // A domain listed twice is one domain.
    const wanted = [...new Set(textArray(domains))];
    const written = await db.query<{ domain: string }>(
      `INSERT INTO ${SITE_DOMAINS} (domain, site_id, position)
       SELECT each.domain, $1, each.position
         FROM unnest($2::text[]) WITH ORDINALITY AS each(domain, position)
       ON CONFLICT (domain) DO NOTHING
       RETURNING domain`,
      [siteId, wanted],
    );
    if (written.rows.length < wanted.length) {
      // The key on the domain is what refused it, so there was no read before
      // the write for two requests to race past.
      const landed = new Set(written.rows.map((row) => row.domain));
      const taken = wanted.find((domain) => !landed.has(domain));
      throw new StoreQueryError('DOMAIN_TAKEN', `${taken} already belongs to another site`);
    }
  }

  const self: Sites = {
    async site(siteId: string): Promise<Site | null> {
      const cached = cache.get(siteId);
      if (cached !== undefined && cached.until > now()) {
        return cached.site;
      }
      const site = await read(pool, siteId);
      cache.set(siteId, { site, until: now() + SITE_CACHE_MS });
      return site;
    },

    async siteOrThrow(siteId: string): Promise<Site> {
      const site = await self.site(siteId);
      if (site === null) {
        throw new StoreQueryError('UNKNOWN_SITE', `No site answers to ${siteId}`);
      }
      return site;
    },

    async sites(): Promise<Site[]> {
      const result = await pool.query<SiteRow>(`${SELECT_SITE} ORDER BY site.id`);
      return result.rows.map(siteOf);
    },

    async siteByShareToken(token: string): Promise<Site | null> {
      // The same expression the unique index is built on, so this is one probe
      // of it.
      const result = await pool.query<SiteRow>(
        `${SELECT_SITE} WHERE (site.share ->> 'token') = $1`,
        [token],
      );
      const row = result.rows[0];
      return row === undefined ? null : siteOf(row);
    },

    async createSite(site: Site): Promise<void> {
      if (site.domains.length === 0) {
        throw new StoreQueryError('DOMAIN_REQUIRED', NO_DOMAIN);
      }
      await transaction(pool, async (db) => {
        const created = await db.query(
          `INSERT INTO ${SITES} (id, name, team_id, settings, share, routes_changed_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
           ON CONFLICT (id) DO NOTHING`,
          [
            text(site.id),
            text(site.name),
            text(site.teamId),
            json(site.settings),
            json(site.share),
            site.routesChangedAt ?? null,
          ],
        );
        if (created.rowCount === 0) {
          throw new StoreQueryError('SITE_EXISTS', `A site already answers to ${site.id}`);
        }
        await writeDomains(db, site.id, site.domains);
      });
      cache.delete(site.id);
    },

    async updateSite(siteId: string, patch: SitePatch): Promise<Site> {
      const updated = await transaction(pool, async (db) => {
        // Locked, so two patches of one site merge one after the other rather
        // than the later one writing over a setting the earlier one changed.
        const current = await read(db, siteId, true);
        if (current === null) {
          throw new StoreQueryError('UNKNOWN_SITE', `No site answers to ${siteId}`);
        }
        const domains = patch.domains ?? current.domains;
        if (domains.length === 0) {
          throw new StoreQueryError('DOMAIN_REQUIRED', NO_DOMAIN);
        }
        const next: Site = {
          ...current,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.teamId === undefined ? {} : { teamId: patch.teamId }),
          domains,
          // Field by field, so a patch naming one setting does not reset the rest.
          settings: { ...current.settings, ...patch.settings },
        };
        // The share: kept, replaced, or taken off with null.
        if (patch.share === null) {
          delete next.share;
        } else if (patch.share !== undefined) {
          next.share = patch.share;
        }
        // A change to the route rules is a change to what every stored row and
        // every route rollup says, so the site is marked and the jobs regroup it.
        if (
          patch.settings?.routeGroups !== undefined &&
          !sameRouteRules(current.settings.routeGroups, patch.settings.routeGroups)
        ) {
          next.routesChangedAt = now();
        }
        if (patch.domains !== undefined) {
          await db.query(`DELETE FROM ${SITE_DOMAINS} WHERE site_id = $1`, [siteId]);
          await writeDomains(db, siteId, patch.domains);
        }
        await db.query(
          `UPDATE ${SITES}
              SET name = $2, team_id = $3, settings = $4::jsonb, share = $5::jsonb,
                  routes_changed_at = $6
            WHERE id = $1`,
          [
            siteId,
            text(next.name),
            text(next.teamId),
            json(next.settings),
            json(next.share),
            next.routesChangedAt ?? null,
          ],
        );
        return next;
      });
      cache.delete(siteId);
      return updated;
    },

    forget(siteId: string): void {
      cache.delete(siteId);
    },
  };

  return self;
}
