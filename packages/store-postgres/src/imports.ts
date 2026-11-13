import {
  checkImportId,
  checkImportRows,
  dayKey,
  IMPORT_DIMS,
  importDecision,
  type ImportRefusedDay,
  type ImportRow,
  type ImportStore,
  type Site,
} from '@chokh/store';
import type { Pool } from 'pg';

import { transaction, type Queryable } from './db.js';
import { LOCK_IMPORTS, advisoryLockSql } from './locks.js';
import { EVENTS, ROLLUPS_DAILY } from './schema.js';
import type { Sites } from './sites.js';

// Imported history on PostgreSQL (packages/store/src/imports.ts has the rules).
//
// An imported row is an ordinary rollups_daily row with import_id set, so every
// read finds it with no change and the primary key still holds one row per
// site, day, dimension and value: an import may only write a day no native row
// and no other import holds. Native rows have import_id NULL.
//
// No index of its own. Every statement here leads with site_id, which the
// primary key (site_id, date, dim, key) serves, and the ones that read a whole
// import (listing, reading, removing) are an operator's rare command, not a
// report. The column is the one thing migrate adds.
//
// A write is one transaction under an advisory lock, so the day rule it applies
// is decided on the same snapshot it writes on, and two imports cannot both
// claim a day.

export interface ImportsDeps {
  pool: Pool;
  sites: Sites;
  now(): number;
}

interface CountRow {
  [column: string]: unknown;
  date: string;
  dim: string;
  key: string;
  visitors: number;
  pageviews: number;
  visits: number;
  bounces: number;
  duration_sum: number;
}

async function ownFrom(db: Queryable, site: Site): Promise<string | null> {
  const result = await db.query<{ native: string | null; first_ts: number | null }>(
    `SELECT (SELECT min(date) FROM ${ROLLUPS_DAILY} WHERE site_id = $1 AND import_id IS NULL)::text AS native,
            (SELECT min(ts) FROM ${EVENTS} WHERE site_id = $1) AS first_ts`,
    [site.id],
  );
  const row = result.rows[0];
  const days = [
    ...(row?.native === null || row?.native === undefined ? [] : [row.native]),
    ...(row?.first_ts === null || row?.first_ts === undefined ? [] : [dayKey(row.first_ts, site.settings.timezone)]),
  ].sort();
  return days[0] ?? null;
}

const INSERT_IMPORT = `
  INSERT INTO ${ROLLUPS_DAILY}
    (site_id, date, dim, key, visitors, pageviews, visits, bounces, duration_sum, import_id)
  SELECT $1, given.date, given.dim, given.key, given.visitors, given.pageviews,
         given.visits, given.bounces, given."durationSum", $2
    FROM jsonb_to_recordset($3::jsonb) AS given(
           date date, dim text, key text, visitors bigint, pageviews bigint,
           visits bigint, bounces bigint, "durationSum" bigint)`;

export function createImports(deps: ImportsDeps): ImportStore {
  const { pool, sites, now } = deps;

  return {
    async importState(siteId) {
      const site = await sites.siteOrThrow(siteId);
      const result = await pool.query<{ import_id: string; days: number; rows: number; first: string; last: string }>(
        `SELECT import_id, count(DISTINCT date) AS days, count(*) AS rows,
                min(date)::text AS first, max(date)::text AS last
           FROM ${ROLLUPS_DAILY}
          WHERE site_id = $1 AND import_id IS NOT NULL
          GROUP BY import_id
          ORDER BY import_id`,
        [siteId],
      );
      return {
        ownFrom: await ownFrom(pool, site),
        imports: result.rows.map((row) => ({
          importId: row.import_id,
          from: row.first,
          to: row.last,
          days: Number(row.days),
          rows: Number(row.rows),
        })),
      };
    },

    async importedRollups(siteId, importId) {
      checkImportId(importId);
      await sites.siteOrThrow(siteId);
      const result = await pool.query<CountRow>(
        `SELECT date::text AS date, dim, key, visitors, pageviews, visits, bounces, duration_sum
           FROM ${ROLLUPS_DAILY}
          WHERE site_id = $1 AND import_id = $2`,
        [siteId, importId],
      );
      const rowsOut: ImportRow[] = [];
      for (const row of result.rows) {
        // Only an import wrote these, through checkImportRows, so every dim is
        // one of IMPORT_DIMS; found rather than asserted all the same.
        const dim = IMPORT_DIMS.find((candidate) => candidate === row.dim);
        if (dim === undefined) continue;
        rowsOut.push({
          date: row.date,
          dim,
          key: row.key,
          visitors: Number(row.visitors),
          pageviews: Number(row.pageviews),
          visits: Number(row.visits),
          bounces: Number(row.bounces),
          durationSum: Number(row.duration_sum),
        });
      }
      return rowsOut;
    },

    async writeImport(siteId, importId, rows) {
      checkImportId(importId);
      const days = checkImportRows(rows);
      const site = await sites.siteOrThrow(siteId);
      const today = dayKey(now(), site.settings.timezone);

      return transaction(pool, async (client) => {
        await client.query(advisoryLockSql(LOCK_IMPORTS));
        const own = await ownFrom(client, site);
        const held = await client.query<{ date: string; import_id: string }>(
          `SELECT date::text AS date, import_id
             FROM ${ROLLUPS_DAILY}
            WHERE site_id = $1 AND dim = 'total' AND import_id IS NOT NULL
              AND import_id <> $2 AND date = ANY($3::date[])`,
          [siteId, importId, days],
        );
        const holders = new Map(held.rows.map((row) => [row.date, row.import_id]));

        const refused: ImportRefusedDay[] = [];
        const accepted: string[] = [];
        for (const date of days) {
          const refusal = importDecision(importId, date, own, today, holders.get(date));
          if (refusal === undefined) accepted.push(date);
          else refused.push(refusal);
        }
        const wanted = new Set(accepted);
        const written = rows.filter((row) => wanted.has(row.date));
        if (accepted.length > 0) {
          await client.query(
            `DELETE FROM ${ROLLUPS_DAILY} WHERE site_id = $1 AND import_id = $2 AND date = ANY($3::date[])`,
            [siteId, importId, accepted],
          );
          if (written.length > 0) {
            await client.query(INSERT_IMPORT, [siteId, importId, JSON.stringify(written)]);
          }
        }
        return { importId, days: accepted.length, rows: written.length, refused };
      });
    },

    async removeImport(siteId, importId) {
      checkImportId(importId);
      await sites.siteOrThrow(siteId);
      const result = await pool.query<{ rows: number; days: number }>(
        `WITH gone AS (
           DELETE FROM ${ROLLUPS_DAILY} WHERE site_id = $1 AND import_id = $2 RETURNING date
         )
         SELECT count(*) AS rows, count(DISTINCT date) AS days FROM gone`,
        [siteId, importId],
      );
      const row = result.rows[0];
      return { importId, days: Number(row?.days ?? 0), rows: Number(row?.rows ?? 0) };
    },
  };
}
