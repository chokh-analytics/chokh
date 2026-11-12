import {
  ROLLED_DIMENSIONS,
  ROLLUP_TOTAL_DIM,
  SESSION_DIMENSIONS,
  SESSION_PATH_BY_DIMENSION,
  addTotals,
  dayBounds,
  dayKey,
  dayKeysBetween,
  routePattern,
  zeroTotals,
  type AnalyticsStore,
  type Dimension,
  type Range,
  type RegroupSummary,
  type RollupDim,
  type RollupRecord,
  type RollupSummary,
  type Totals,
} from '@chokh/store';
import type { Pool } from 'pg';

import { json, transaction } from './db.js';
import {
  rawBreakdownSql,
  rawTotalsSql,
  sessionBreakdownSql,
  sessionSourcedBreakdownSql,
  sessionTotalsSql,
  type Statement,
} from './reads.sql.js';
import { EVENTS, ROLLUPS_DAILY, SITES } from './schema.js';
import type { Sites } from './sites.js';

// The daily rollups: one row per site, day, dimension and value, in an
// ordinary table that rollupDay writes. Not a materialised view, on purpose: a
// view is recomputed from the raw rows whenever it is refreshed, and the raw
// rows are exactly what the retention purge takes away, so the first refresh
// after a purge would delete the history these rows exist to keep.

export type Rollup = Pick<AnalyticsStore, 'rollupDay' | 'regroupRoutes'>;

export interface RollupDeps {
  pool: Pool;
  sites: Sites;
  now(): number;
}

// The route of a row from a site's rules: the first rule the path matches,
// else the path itself, and no route at all on a row with no path. The same
// patterns routeOf compiles for the other adapters, handed to ~ as they are.
export function routeSql(rules: readonly string[], add: (value: unknown) => string): string {
  if (rules.length === 0) {
    return 'path';
  }
  const cases = rules.map((rule) => `WHEN path ~ ${add(routePattern(rule))} THEN ${add(rule)}`);
  return `CASE WHEN path IS NULL THEN NULL ${cases.join(' ')} ELSE path END`;
}

// The jobs that are meant to be long lift the statement timeout for their own
// transaction and for nothing else.
export const NO_STATEMENT_TIMEOUT = 'SET LOCAL statement_timeout = 0';

type Counts = Record<string, number | string | null>;

// The dimensions a day is rolled by, split by where their numbers come from.
// Visitors and pageviews come from events, except for the three only a stay
// carries; visits, bounces and time come from stays wherever a stay has the
// dimension at all.
const FROM_EVENTS: readonly Dimension[] = ROLLED_DIMENSIONS.filter(
  (dim) => !SESSION_DIMENSIONS.includes(dim),
);
const VISITS_FROM_STAYS: readonly Dimension[] = FROM_EVENTS.filter(
  (dim) => SESSION_PATH_BY_DIMENSION[dim] !== undefined,
);
const FROM_STAYS: readonly Dimension[] = ROLLED_DIMENSIONS.filter((dim) =>
  SESSION_DIMENSIONS.includes(dim),
);

const INSERT_ROLLUPS = `
  INSERT INTO ${ROLLUPS_DAILY}
    (site_id, date, dim, key, visitors, pageviews, visits, bounces, duration_sum)
  SELECT $1, $2::date, given.dim, given.key, given.visitors, given.pageviews,
         given.visits, given.bounces, given."durationSum"
    FROM jsonb_to_recordset($3::jsonb) AS given(
           dim text, key text, visitors bigint, pageviews bigint,
           visits bigint, bounces bigint, "durationSum" bigint)`;

export function createRollup(deps: RollupDeps): Rollup {
  const { pool, sites, now } = deps;

  async function ask(statement: Statement): Promise<Counts[]> {
    const result = await pool.query<Counts>(statement.text, statement.values);
    return result.rows;
  }

  async function totalsOf(statement: Statement): Promise<Totals> {
    const totals = zeroTotals();
    for (const row of await ask(statement)) {
      addTotals(totals, row as Partial<Totals>);
    }
    return totals;
  }

  return {
    async rollupDay(siteId: string, date: string): Promise<RollupSummary> {
      const site = await sites.siteOrThrow(siteId);
      const timezone = site.settings.timezone;
      const bounds = dayBounds(date, timezone);
      const span: Range = { from: bounds.start, to: bounds.end };

      // The same statements a raw read of this day runs, so a rolled day is
      // what a raw read of it answered, by construction.
      const [humans, crawlers, humanStays, crawlerStays] = await Promise.all([
        totalsOf(rawTotalsSql(siteId, span, timezone, false, undefined)),
        totalsOf(rawTotalsSql(siteId, span, timezone, true, undefined)),
        totalsOf(sessionTotalsSql(siteId, span, false, undefined)),
        totalsOf(sessionTotalsSql(siteId, span, true, undefined)),
      ]);
      // Any event at all is a visitor that day, and any stay is a visit.
      const anyHumans = humans.visitors > 0 || humanStays.visits > 0;
      const anyCrawlers = crawlers.visitors > 0 || crawlerStays.visits > 0;
      if (!anyHumans && !anyCrawlers) {
        // A day with no rows of its own leaves whatever was rolled up before
        // alone. The retention purge takes raw rows away long before the
        // rollups go, and a rerun after it must not wipe the history it
        // preserved.
        return { siteId, date, rows: 0, visitors: 0, pageviews: 0 };
      }

      const records: RollupRecord[] = [];
      const push = (dim: RollupDim, key: string, ...parts: Partial<Totals>[]): Totals => {
        const totals = zeroTotals();
        for (const part of parts) {
          addTotals(totals, part);
        }
        records.push({ siteId, date, dim, key, ...totals });
        return totals;
      };

      const total = push(ROLLUP_TOTAL_DIM, '', humans, humanStays);
      if (anyHumans) push('bot', 'false', humans, humanStays);
      if (anyCrawlers) push('bot', 'true', crawlers, crawlerStays);

      // Every rolled dimension in three passes of the day rather than one or
      // two statements per dimension.
      const [events, visits, stays] = await Promise.all([
        ask(rawBreakdownSql(siteId, span, timezone, FROM_EVENTS, false, undefined)),
        ask(sessionBreakdownSql(siteId, span, VISITS_FROM_STAYS, false, undefined)),
        ask(sessionSourcedBreakdownSql(siteId, span, timezone, FROM_STAYS, false, undefined)),
      ]);
      const byKey = new Map<string, { dim: Dimension; key: string; parts: Partial<Totals>[] }>();
      for (const row of [...events, ...visits, ...stays]) {
        const dim = String(row.dim) as Dimension;
        const key = String(row.key);
        const slot = `${dim}\n${key}`;
        const found = byKey.get(slot) ?? { dim, key, parts: [] };
        found.parts.push(row as Partial<Totals>);
        byKey.set(slot, found);
      }
      for (const { dim, key, parts } of byKey.values()) {
        push(dim, key, ...parts);
      }

      // The day is replaced in one transaction, so a read never finds it
      // missing in the middle of being rewritten.
      await transaction(pool, async (db) => {
        await db.query(NO_STATEMENT_TIMEOUT);
        await db.query(`DELETE FROM ${ROLLUPS_DAILY} WHERE site_id = $1 AND date = $2::date`, [
          siteId,
          date,
        ]);
        await db.query(INSERT_ROLLUPS, [siteId, date, json(records)]);
      });
      return {
        siteId,
        date,
        rows: records.length,
        visitors: total.visitors,
        pageviews: total.pageviews,
      };
    },

    async regroupRoutes(siteId: string): Promise<RegroupSummary> {
      const site = await sites.siteOrThrow(siteId);
      const timezone = site.settings.timezone;

      // Every row of the site takes the route the rules give it now. Only the
      // rows whose route changes are written: an UPDATE writes a new version
      // of every row it names, changed or not, so naming them all would
      // rewrite the site's whole history to change a handful of pages.
      const params: unknown[] = [siteId];
      const route = routeSql(site.settings.routeGroups, (value) => {
        params.push(value);
        return `$${params.length}`;
      });
      const considered = await transaction(pool, async (db) => {
        await db.query(NO_STATEMENT_TIMEOUT);
        const counted = await db.query<{ n: number; first: number | null; last: number | null }>(
          `SELECT count(*) AS n, min(ts) AS first, max(ts) AS last FROM ${EVENTS} WHERE site_id = $1`,
          [siteId],
        );
        await db.query(
          `UPDATE ${EVENTS} SET route = ${route}
            WHERE site_id = $1 AND route IS DISTINCT FROM (${route})`,
          params,
        );
        const span = counted.rows[0] ?? { n: 0, first: null, last: null };
        // Which days of the site's calendar still have rows: the same walk of
        // the whole site, so it rides in the transaction that is allowed to be
        // long rather than under the limit a report has.
        let held: string[] = [];
        if (span.first !== null && span.last !== null) {
          const keys = dayKeysBetween(Number(span.first), Number(span.last) + 1, timezone);
          const starts = keys.map((key) => dayBounds(key, timezone).start);
          const found = await db.query<{ day: number }>(
            `SELECT DISTINCT width_bucket(ts, $2::bigint[]) AS day FROM ${EVENTS} WHERE site_id = $1`,
            [siteId, starts],
          );
          held = found.rows
            .map((row) => keys[Number(row.day) - 1])
            .filter((key): key is string => key !== undefined);
        }
        return { n: Number(span.n), held };
      });

      // Then the route rollups of every past day that still has rows, and only
      // those: a day whose rows have expired keeps the rollup it had.
      const today = dayKey(now(), timezone);
      const days = considered.held.filter((key) => key !== today).sort();
      for (const date of days) {
        const bounds = dayBounds(date, timezone);
        const span: Range = { from: bounds.start, to: bounds.end };
        const found = await ask(rawBreakdownSql(siteId, span, timezone, ['route'], false, undefined));
        const records = found.map((row): RollupRecord => {
          const totals = zeroTotals();
          addTotals(totals, row as Partial<Totals>);
          return { siteId, date, dim: 'route', key: String(row.key), ...totals };
        });
        await transaction(pool, async (db) => {
          await db.query(
            `DELETE FROM ${ROLLUPS_DAILY} WHERE site_id = $1 AND date = $2::date AND dim = 'route'`,
            [siteId, date],
          );
          if (records.length > 0) {
            await db.query(INSERT_ROLLUPS, [siteId, date, json(records)]);
          }
        });
      }

      await pool.query(`UPDATE ${SITES} SET routes_changed_at = NULL WHERE id = $1`, [siteId]);
      sites.forget(siteId);
      return { siteId, events: considered.n, days: days.length };
    },
  };
}
