import { addDays, dayKey, type AnalyticsStore, type Site } from '../store/AnalyticsStore.js';

// The three background jobs, in one place, because "is the rollup running" is
// a question an operator asks about the process and not about a module.
//
// All three are idempotent. Running the rollup twice writes the same numbers,
// running the purge twice deletes nothing the second time, and the geo refresh
// checks the file's age before it downloads. Nothing here holds a lock: two
// processes running the same rollup hour is harmless, which is what lets an
// install scale out without electing a leader.

export const ROLLUP_EVERY_MS = 60 * 60 * 1000;
// A day is rolled again on every tick while it is yesterday, so an outage
// shorter than this heals itself on the next tick. On the first tick after a
// start, the week before it is rolled too, so a longer one heals at a restart.
export const ROLLUP_BACKFILL_DAYS = 7;

export interface JobLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface JobDeps {
  store: AnalyticsStore;
  log: JobLog;
  now(): number;
}

// The date keys a site may be rolled for, newest first.
//
// Yesterday is the newest, because today is not over: the site's own midnight
// decides when it is, which is why this is drawn per site and not per process.
//
// The oldest is retention minus one day. A day older than that has raw rows
// that have begun to expire, so rolling it again would overwrite a good rollup
// with a smaller one, and a rollup is the only copy of history that outlives
// the raw rows.
export function rollableDays(site: Site, at: number, backfill: number): string[] {
  const timezone = site.settings.timezone;
  const today = dayKey(at, timezone);
  const retention = site.settings.retentionDays;
  // No retention set means the raw rows are kept until somebody purges them,
  // so nothing is out of reach.
  const oldest = retention > 0 ? addDays(today, -(retention - 1)) : null;
  const days: string[] = [];
  for (let back = 1; back <= backfill; back += 1) {
    const day = addDays(today, -back);
    if (oldest !== null && day < oldest) {
      break;
    }
    days.push(day);
  }
  return days;
}

// One pass of the hourly work: roll up what can be rolled up, then take away
// what the site's retention no longer covers.
export async function runJobsOnce(deps: JobDeps, backfill: number): Promise<void> {
  const at = deps.now();
  const sites = await deps.store.sites();
  for (const site of sites) {
    for (const day of rollableDays(site, at, backfill)) {
      try {
        const summary = await deps.store.rollupDay(site.id, day);
        if (summary.rows > 0) {
          deps.log.info(summary, 'rolled a day up');
        }
      } catch (error) {
        deps.log.warn({ err: error, siteId: site.id, date: day }, 'rollup failed');
      }
    }

    if (site.settings.retentionDays <= 0) {
      continue;
    }
    const before = at - site.settings.retentionDays * 24 * 60 * 60 * 1000;
    try {
      const purged = await deps.store.purge(site.id, before);
      if (purged.events > 0 || purged.sessions > 0 || purged.visitors > 0) {
        deps.log.info({ siteId: site.id, ...purged }, 'purged past the site retention');
      }
    } catch (error) {
      deps.log.warn({ err: error, siteId: site.id }, 'retention purge failed');
    }
  }
}

export function startJobs(deps: JobDeps): () => void {
  let running = false;
  let first = true;

  const tick = async (): Promise<void> => {
    if (running) {
      // The previous hour is still working. Skipping is right: the next tick
      // rolls the same day, and two passes over one day would only race.
      return;
    }
    running = true;
    try {
      await runJobsOnce(deps, first ? ROLLUP_BACKFILL_DAYS : 1);
      first = false;
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), ROLLUP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
