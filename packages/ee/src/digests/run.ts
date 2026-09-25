import type { AccountStore, AlertDelivery, AnalyticsStore, Digest, Site } from '@chokh/store';

import type { Deliverer } from '../alerts/deliver.js';
import { TICK_MS } from '../alerts/conditions.js';
import type { LicenseState } from '../license/state.js';
import { composeDigest, digestMail } from './compose.js';
import { DIGESTS_FEATURE, isDue, periodFor, type DigestPeriod } from './period.js';

// The digest tick (AN-RPT01): every five minutes, for every digest whose hour
// has come in its site's zone and whose period is not yet claimed, one
// compose and one mail per address. The claim is the store's compare-and-set,
// so every process may tick and each period goes once. A period whose mail
// reached nobody stays claimed: a digest that arrives twice is worse than one
// that arrives late, and the page shows what happened.

export interface DigestLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface DigestDeps {
  store: AnalyticsStore & AccountStore;
  deliver: Deliverer;
  license: LicenseState;
  log: DigestLog;
  publicUrl?: string | undefined;
  now(): number;
}

export interface DigestRunSummary {
  licensed: boolean;
  sites: number;
  digests: number;
  sent: number;
  failed: number;
}

// Compose and mail one digest for one period, and write down what happened.
export async function sendDigest(
  deps: Pick<DigestDeps, 'store' | 'deliver' | 'publicUrl' | 'now'>,
  site: Site,
  digest: Digest,
  period: DigestPeriod,
): Promise<AlertDelivery[]> {
  const report = await composeDigest(deps.store, site, digest, period);
  const mail = await digestMail(report, deps.publicUrl);
  const deliveries: AlertDelivery[] = [];
  for (const to of digest.to) {
    const error = await deps.deliver.sendMail(to, mail);
    deliveries.push(
      error === null ? { channel: 'email', target: to, ok: true } : { channel: 'email', target: to, ok: false, error },
    );
  }
  await deps.store.recordDigestSend(site.id, digest.id, {
    at: deps.now(),
    period: period.key,
    deliveries,
  });
  return deliveries;
}

export async function runDigestsOnce(deps: DigestDeps): Promise<DigestRunSummary> {
  const now = deps.now();
  const summary: DigestRunSummary = {
    licensed: deps.license.allows(DIGESTS_FEATURE, now).ok,
    sites: 0,
    digests: 0,
    sent: 0,
    failed: 0,
  };
  if (!summary.licensed) {
    return summary;
  }
  const sites = await deps.store.sites();
  summary.sites = sites.length;
  for (const site of sites) {
    const digests = await deps.store.digests(site.id);
    summary.digests += digests.length;
    for (const digest of digests) {
      const timezone = site.settings.timezone;
      if (!isDue(digest, now, timezone)) {
        continue;
      }
      const period = periodFor(digest.cadence, now, timezone);
      if (!(await deps.store.claimDigestSend(site.id, digest.id, period.key))) {
        continue;
      }
      try {
        const deliveries = await sendDigest(deps, site, digest, period);
        const failed = deliveries.filter((each) => !each.ok);
        summary.sent += deliveries.length - failed.length;
        summary.failed += failed.length;
        if (failed.length > 0) {
          deps.log.warn(
            { siteId: site.id, digestId: digest.id, period: period.key, failed },
            'a digest reached fewer than all of its addresses',
          );
        }
      } catch (error) {
        summary.failed += digest.to.length;
        deps.log.warn(
          { err: error, siteId: site.id, digestId: digest.id, period: period.key },
          'a digest could not be composed',
        );
      }
    }
  }
  return summary;
}

export function startDigestTick(deps: DigestDeps): () => void {
  let running = false;
  let saidUnlicensed = false;

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const summary = await runDigestsOnce(deps);
      if (!summary.licensed) {
        if (!saidUnlicensed) {
          deps.log.info({}, 'digests are not licensed on this install, nothing is sent');
          saidUnlicensed = true;
        }
        return;
      }
      saidUnlicensed = false;
      if (summary.sent > 0 || summary.failed > 0) {
        deps.log.info(summary, 'digests sent');
      }
    } catch (error) {
      deps.log.warn({ err: error }, 'digest tick failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
