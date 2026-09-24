import type {
  AccountStore,
  Alert,
  AlertDelivery,
  AlertFiring,
  AnalyticsStore,
  GoalRead,
  Site,
} from '@chokh/store';

import type { LicenseState } from '../license/state.js';
import {
  ALERTS_FEATURE,
  DAY_MS,
  SKIPPED,
  TICK_MS,
  bucketOf,
  decideCount,
  decideSilence,
  decideTraffic,
  inStatusClass,
  trafficSpans,
  windowSpan,
  type Decision,
} from './conditions.js';
import type { Deliverer } from './deliver.js';
import { messageFor, type AlertEvent } from './messages.js';

// The tick. Every five minutes, every alert of every site: claim its bucket,
// read its numbers, decide, and say so when the answer changed.
//
// Every process of an install runs this, and the claim is what makes that
// safe: claimAlertCheck compares and sets the bucket in one write, so two
// processes ticking at once evaluate each bucket once between them, with no
// leader and no lock. A crash between the claim and the record loses one
// bucket and nothing else.
//
// An alert speaks once per episode: "fired" when its condition first holds,
// "back to normal" when it first stops, nothing in between (founder decision
// D2, 2026-09-24). A delivery that failed on every channel leaves the state
// as it was, so the next bucket tries again rather than an outage going
// unannounced because a mail server blinked.

export interface EvaluateLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface EvaluateDeps {
  store: AnalyticsStore & AccountStore;
  deliver: Deliverer;
  license: LicenseState;
  log: EvaluateLog;
  publicUrl?: string | undefined;
  now(): number;
}

export interface RunSummary {
  licensed: boolean;
  sites: number;
  alerts: number;
  // How many buckets this process claimed, and what came of them.
  claimed: number;
  fired: number;
  recovered: number;
  skipped: number;
  failed: number;
}

function goalRead(goal: { kind: 'page' | 'event'; match: string; value?: number }): GoalRead {
  return goal.value === undefined
    ? { kind: goal.kind, match: goal.match }
    : { kind: goal.kind, match: goal.match, value: goal.value };
}

// The numbers one alert needs at one instant, read through the store, and the
// decision they lead to. Exported so a test can ask it directly.
export async function measure(
  store: AnalyticsStore & AccountStore,
  site: Site,
  alert: Alert,
  now: number,
): Promise<Decision | typeof SKIPPED> {
  const condition = alert.condition;
  const siteId = site.id;
  switch (condition.kind) {
    case 'traffic': {
      const { current, baselines } = trafficSpans(now);
      // A baseline hour whose rows have begun to expire would read low and
      // call every quiet morning a drop, so only hours inside retention count.
      const retention = site.settings.retentionDays;
      const oldest = retention > 0 ? now - retention * DAY_MS : Number.NEGATIVE_INFINITY;
      const kept = baselines.filter((span) => span.from >= oldest);
      const reads = await Promise.all(
        [current, ...kept].map((span) => store.aggregate({ siteId, from: span.from, to: span.to })),
      );
      const values = reads.map((read) => read.metrics[condition.metric]);
      return decideTraffic(condition, values[0] ?? 0, values.slice(1));
    }
    case 'goal': {
      const goal = await store.goal(siteId, condition.goalId);
      if (goal === null) {
        // The goal was deleted after the alert was made. Nothing to count, and
        // the page says so beside the alert.
        return SKIPPED;
      }
      const span = windowSpan(condition, now);
      const read = await store.aggregate({ siteId, from: span.from, to: span.to, goal: goalRead(goal) });
      return decideCount(condition.direction, condition.count, read.conversion?.completions ?? 0);
    }
    case 'errors': {
      const span = windowSpan(condition, now);
      const read = await store.breakdown({ siteId, from: span.from, to: span.to, dim: 'status', limit: 100 });
      const pages = read.rows
        .filter((row) => inStatusClass(condition.statuses, row.key))
        .reduce((sum, row) => sum + row.metrics.pageviews, 0);
      return decideCount('above', condition.count, pages);
    }
    case 'silence': {
      const span = windowSpan(condition, now);
      const [inWindow, dayBefore] = await Promise.all([
        store.aggregate({ siteId, from: span.from, to: span.to }),
        store.aggregate({ siteId, from: span.from - DAY_MS, to: span.from }),
      ]);
      return decideSilence(inWindow.metrics.pageviews, dayBefore.metrics.pageviews);
    }
  }
}

// Send one event about one alert on every channel it names, and answer each
// channel's outcome. The test route uses this too, with event 'test'.
export async function notify(
  deps: Pick<EvaluateDeps, 'store' | 'deliver' | 'publicUrl'>,
  site: Site,
  alert: Alert,
  event: AlertEvent,
  decision: Decision | null,
  at: number,
): Promise<AlertDelivery[]> {
  const goalName =
    alert.condition.kind === 'goal'
      ? ((await deps.store.goal(site.id, alert.condition.goalId))?.name ?? undefined)
      : undefined;
  const message = messageFor({
    event,
    alert,
    site,
    decision,
    at,
    publicUrl: deps.publicUrl,
    goalName,
  });
  const outcomes: AlertDelivery[] = [];
  for (const channel of alert.channels) {
    outcomes.push(await deps.deliver.send(channel, message));
  }
  return outcomes;
}

export async function runAlertsOnce(deps: EvaluateDeps): Promise<RunSummary> {
  const now = deps.now();
  const summary: RunSummary = {
    licensed: deps.license.allows(ALERTS_FEATURE, now).ok,
    sites: 0,
    alerts: 0,
    claimed: 0,
    fired: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
  };
  if (!summary.licensed) {
    // A key that ran out stops the messages the way it stops the routes. The
    // rows stay, and the next licensed tick picks them up.
    return summary;
  }

  const sites = await deps.store.sites();
  summary.sites = sites.length;
  for (const site of sites) {
    const alerts = await deps.store.alerts(site.id);
    summary.alerts += alerts.length;
    for (const alert of alerts) {
      const bucket = bucketOf(alert.condition, now);
      if (!(await deps.store.claimAlertCheck(site.id, alert.id, bucket))) {
        continue;
      }
      summary.claimed += 1;

      let decision: Decision | typeof SKIPPED;
      try {
        decision = await measure(deps.store, site, alert, now);
      } catch (error) {
        deps.log.warn({ err: error, siteId: site.id, alertId: alert.id }, 'alert read failed');
        summary.failed += 1;
        continue;
      }
      if (decision === SKIPPED) {
        summary.skipped += 1;
        continue;
      }
      if (decision.firing === alert.state.firing) {
        // The same answer as last time: nothing to say.
        continue;
      }

      const event: AlertEvent = decision.firing ? 'fired' : 'recovered';
      const deliveries = await notify(deps, site, alert, event, decision, now);
      const firing: AlertFiring = {
        at: now,
        event,
        value: decision.value,
        baseline: decision.baseline,
        deliveries,
      };
      const delivered = deliveries.some((outcome) => outcome.ok);
      if (!delivered) {
        // Nobody heard. The transition is written down with its failures and
        // the state is left as it was, so the next bucket says it again.
        await deps.store.recordAlertState(
          site.id,
          alert.id,
          { firing: alert.state.firing, ...(alert.state.since === undefined ? {} : { since: alert.state.since }) },
          firing,
        );
        deps.log.warn({ siteId: site.id, alertId: alert.id, event, deliveries }, 'alert not delivered');
        summary.failed += 1;
        continue;
      }
      await deps.store.recordAlertState(
        site.id,
        alert.id,
        decision.firing ? { firing: true, since: now } : { firing: false },
        firing,
      );
      deps.log.info({ siteId: site.id, alertId: alert.id, event, value: decision.value, baseline: decision.baseline }, `alert ${event}`);
      if (event === 'fired') {
        summary.fired += 1;
      } else {
        summary.recovered += 1;
      }
    }
  }
  return summary;
}

// The interval, started once per process. The first pass runs at once, so an
// install that just booted with a key does not wait five minutes to notice a
// site has gone quiet; a pass that is still running when the next is due is
// skipped, the way the core's rollup tick skips.
export function startAlertTick(deps: EvaluateDeps): () => void {
  let running = false;
  let saidUnlicensed = false;

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const summary = await runAlertsOnce(deps);
      if (!summary.licensed) {
        if (!saidUnlicensed) {
          deps.log.info({}, 'alerts are not licensed on this install, nothing is evaluated');
          saidUnlicensed = true;
        }
        return;
      }
      saidUnlicensed = false;
      if (summary.claimed > 0) {
        deps.log.info(summary, 'alerts evaluated');
      }
    } catch (error) {
      deps.log.warn({ err: error }, 'alert tick failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
