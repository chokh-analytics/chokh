import {
  checkImportId,
  checkImportRows,
  dayKey,
  importDecision,
  type ImportRefusedDay,
  type ImportRow,
  type ImportStore,
  type ImportSummary,
  type RollupRecord,
  type Site,
} from '@chokh/store';
import type { Collection } from 'mongodb';

// Imported history on MongoDB (packages/store/src/imports.ts has the rules).
//
// An imported row is an ordinary rollups_daily document with an importId, so
// every read finds it with no change. No index of its own: every statement here
// leads with siteId, which the existing rollup_key index (siteId, date, dim,
// key) serves, and the ones that scan a site's rollups (listing, reading or
// removing a whole import) are an operator's rare command, not a report. So an
// install that never imports owes no migration for this.
//
// Not one transaction: a write deletes the import's rows of the accepted days
// and inserts the new ones. Run again after a failure it writes the same rows,
// and no native write can land on those days (the rule refuses any day the site
// could still get rows for).

interface Deps {
  rollups: Collection<RollupRecord>;
  events: Collection<{ siteId: string; ts: number }>;
  siteOrThrow(siteId: string): Promise<Site>;
  now(): number;
}

export function createImports(deps: Deps): ImportStore {
  const { rollups, events, siteOrThrow, now } = deps;

  async function ownFrom(site: Site): Promise<string | null> {
    const [native, raw] = await Promise.all([
      rollups
        .find({ siteId: site.id, importId: { $exists: false } }, { projection: { _id: 0, date: 1 } })
        .sort({ date: 1 })
        .limit(1)
        .next(),
      events.find({ siteId: site.id }, { projection: { _id: 0, ts: 1 } }).sort({ ts: 1 }).limit(1).next(),
    ]);
    const days = [
      ...(native === null ? [] : [native.date]),
      ...(raw === null ? [] : [dayKey(raw.ts, site.settings.timezone)]),
    ].sort();
    return days[0] ?? null;
  }

  return {
    async importState(siteId) {
      const site = await siteOrThrow(siteId);
      const imports = await rollups
        .aggregate<{ _id: string; days: number; rows: number; from: string; to: string }>([
          { $match: { siteId, importId: { $exists: true } } },
          { $group: { _id: { importId: '$importId', date: '$date' }, rows: { $sum: 1 } } },
          {
            $group: {
              _id: '$_id.importId',
              days: { $sum: 1 },
              rows: { $sum: '$rows' },
              from: { $min: '$_id.date' },
              to: { $max: '$_id.date' },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray();
      return {
        ownFrom: await ownFrom(site),
        imports: imports.map(
          (entry): ImportSummary => ({
            importId: entry._id,
            from: entry.from,
            to: entry.to,
            days: entry.days,
            rows: entry.rows,
          }),
        ),
      };
    },

    async importedRollups(siteId, importId) {
      checkImportId(importId);
      await siteOrThrow(siteId);
      const rows = await rollups.find({ siteId, importId }).toArray();
      return rows.map(
        (row): ImportRow => ({
          date: row.date,
          dim: row.dim,
          key: row.key,
          visitors: row.visitors,
          pageviews: row.pageviews,
          visits: row.visits,
          bounces: row.bounces,
          durationSum: row.durationSum,
        }),
      );
    },

    async writeImport(siteId, importId, rows) {
      checkImportId(importId);
      const days = checkImportRows(rows);
      const site = await siteOrThrow(siteId);
      const own = await ownFrom(site);
      const today = dayKey(now(), site.settings.timezone);
      const held = await rollups
        .find(
          { siteId, dim: 'total', date: { $in: days }, importId: { $exists: true, $ne: importId } },
          { projection: { _id: 0, date: 1, importId: 1 } },
        )
        .toArray();
      const holders = new Map<string, string>();
      for (const row of held) {
        if (row.importId !== undefined) holders.set(row.date, row.importId);
      }

      const refused: ImportRefusedDay[] = [];
      const accepted: string[] = [];
      for (const date of days) {
        const refusal = importDecision(importId, date, own, today, holders.get(date));
        if (refusal === undefined) accepted.push(date);
        else refused.push(refusal);
      }
      const wanted = new Set(accepted);
      const written: RollupRecord[] = rows
        .filter((row) => wanted.has(row.date))
        .map((row) => ({
          siteId,
          date: row.date,
          dim: row.dim,
          key: row.key,
          visitors: row.visitors,
          pageviews: row.pageviews,
          visits: row.visits,
          bounces: row.bounces,
          durationSum: row.durationSum,
          importId,
        }));
      if (accepted.length > 0) {
        await rollups.deleteMany({ siteId, importId, date: { $in: accepted } });
        if (written.length > 0) await rollups.insertMany(written, { ordered: false });
      }
      return { importId, days: accepted.length, rows: written.length, refused };
    },

    async removeImport(siteId, importId) {
      checkImportId(importId);
      await siteOrThrow(siteId);
      const days = await rollups.distinct('date', { siteId, importId });
      const result = await rollups.deleteMany({ siteId, importId });
      return { importId, days: days.length, rows: result.deletedCount };
    },
  };
}
