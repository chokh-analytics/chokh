import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, ok, requireSiteScope, type ApiDeps } from '@chokh/server';
import { MAX_ALERTS_PER_SITE, alertIdFor, type Alert, type StoreQueryError } from '@chokh/store';

import { ALERTS_FEATURE, alertParamsSchema, createAlertSchema } from '../alerts/conditions.js';
import type { Deliverer } from '../alerts/deliver.js';
import { notify, startAlertTick } from '../alerts/evaluate.js';
import { describeCondition } from '../alerts/messages.js';
import { requireLicense } from '../license/guard.js';
import type { LicenseState } from '../license/state.js';

// Every paid route, in one file, the way the core keeps its own in one file:
// the whole authorization model is readable in one place, and a route that
// forgot its gate is visible rather than buried.
//
// Two hooks on each, in this order and built at each registration. The scope
// hook first, so a caller with no session or no role on the site is refused for
// that and never told which paid feature lives at the path they guessed. The
// licence hook second, and a fresh one per route: a shared array would give
// every route the first one's feature name.

export const PING_FEATURE = 'ee.ping';

export interface EeRouteDeps {
  deliver: Deliverer;
  publicUrl?: string | undefined;
  // Whether register starts the five-minute tick. The server does; a test
  // that only wants the routes does not.
  tick: boolean;
}

// What the store refuses with, turned into the envelope's status. Only the
// codes an alert write can meet; anything else is a fault and is rethrown.
const STATUS_BY_CODE: Record<string, number> = {
  UNKNOWN_SITE: 404,
  ALERT_EXISTS: 409,
  ALERT_LIMIT: 409,
};

function refusalOf(error: unknown): { status: number; code: string; message: string } | null {
  const candidate = error as Partial<StoreQueryError> | null;
  if (candidate === null || typeof candidate !== 'object' || candidate.name !== 'StoreQueryError') {
    return null;
  }
  const code = candidate.code ?? 'REFUSED';
  const status = STATUS_BY_CODE[code];
  return status === undefined ? null : { status, code, message: candidate.message ?? code };
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
}

export async function registerEeRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  state: LicenseState,
  ee: EeRouteDeps,
): Promise<void> {
  const auth = { store: deps.store, session: deps.session, now: deps.now };
  const store = deps.store;

  // The frame's own health probe, and the feature AN-EE01 is verified against.
  //
  // It stays after the first real paid feature lands, because it is the one
  // route whose only job is to answer the question "is the gate working on this
  // install", and an operator who has just pasted a key in wants to ask that
  // without buying anything else first.
  app.get(
    '/api/sites/:siteId/ee/ping',
    { preHandler: [requireSiteScope(auth, 'read:stats'), requireLicense(state, PING_FEATURE)] },
    () => ok({ pong: true, feature: PING_FEATURE }),
  );

  // Alerts. Reading the list is read:stats, because what the site watches is
  // part of reading the site; adding, deleting and sending a test are admin,
  // the scope goals and segments take: an alert sends messages out of the
  // product, so who may add one is who may change the site (AN-SEG01 D1).
  const alerts = '/api/sites/:siteId/ee/alerts';

  app.get(
    alerts,
    { preHandler: [requireSiteScope(auth, 'read:stats'), requireLicense(state, ALERTS_FEATURE)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const site = request.site;
      if (site === null) {
        return unauthenticated(reply);
      }
      const rows = await store.alerts(site.id);
      // The goal names, so the page can say "Signed up" and not "g_4f2a".
      const goals = await store.goals(site.id);
      const goalNames = new Map(goals.map((goal) => [goal.id, goal.name]));
      const listed = rows.map((alert) => ({
        ...alert,
        // What it watches, as one sentence, written where the words live.
        watches: describeCondition(
          alert.condition,
          alert.condition.kind === 'goal' ? goalNames.get(alert.condition.goalId) : undefined,
        ),
      }));
      return reply.send(
        ok(
          { alerts: listed },
          // Which kinds this install can send on, so a form offers those only.
          { siteId: site.id, max: MAX_ALERTS_PER_SITE, channels: ee.deliver.available },
        ),
      );
    },
  );

  app.post(
    alerts,
    { preHandler: [requireSiteScope(auth, 'admin'), requireLicense(state, ALERTS_FEATURE)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const site = request.site;
      const principal = request.principal;
      if (site === null || principal === null) {
        return unauthenticated(reply);
      }
      const parsed = createAlertSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(fail('INVALID_ALERT', 'The alert did not validate', parsed.error.issues));
      }
      // A channel this install cannot send on is refused now, naming the
      // variable, rather than kept and found dead on the night it mattered.
      const unavailable = parsed.data.channels.find(
        (channel) => !ee.deliver.available.includes(channel.kind),
      );
      if (unavailable !== undefined) {
        const variable =
          unavailable.kind === 'email'
            ? 'CHOKH_SMTP_URL and CHOKH_MAIL_FROM'
            : 'CHOKH_TELEGRAM_BOT_TOKEN';
        return reply
          .code(400)
          .send(
            fail(
              'CHANNEL_UNAVAILABLE',
              `This install cannot send ${unavailable.kind}: set ${variable}`,
              { channel: unavailable.kind, variable },
            ),
          );
      }
      if (parsed.data.condition.kind === 'goal') {
        const goal = await store.goal(site.id, parsed.data.condition.goalId);
        if (goal === null) {
          return reply
            .code(400)
            .send(fail('INVALID_ALERT', `No goal ${parsed.data.condition.goalId} belongs to ${site.id}`));
        }
      }
      const alert: Alert = {
        siteId: site.id,
        id: alertIdFor(site.id, parsed.data.condition),
        name: parsed.data.name,
        condition: parsed.data.condition,
        channels: parsed.data.channels,
        createdBy: principal.id,
        createdAt: deps.now(),
        state: { firing: false },
        recent: [],
      };
      try {
        await store.createAlert(alert);
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === null) {
          throw error;
        }
        const details = refusal.code === 'ALERT_EXISTS' ? { alertId: alert.id } : undefined;
        return reply.code(refusal.status).send(fail(refusal.code, refusal.message, details));
      }
      return reply.code(201).send(ok({ alert }));
    },
  );

  app.delete(
    `${alerts}/:alertId`,
    { preHandler: [requireSiteScope(auth, 'admin'), requireLicense(state, ALERTS_FEATURE)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const site = request.site;
      if (site === null) {
        return unauthenticated(reply);
      }
      const params = alertParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(fail('INVALID_PARAMS', 'The alert id did not validate', params.error.issues));
      }
      const deleted = await store.deleteAlert(site.id, params.data.alertId);
      if (!deleted) {
        return reply
          .code(404)
          .send(fail('ALERT_NOT_FOUND', `No alert ${params.data.alertId} belongs to ${site.id}`));
      }
      return reply.send(ok({ deleted: true }));
    },
  );

  // A test message on every channel of one alert, now, with each channel's
  // outcome in the answer: how a person proves a bot token or an SMTP password
  // without waiting for a spike. 200 whatever the outcomes, because the route
  // did what was asked; the outcomes are the answer.
  app.post(
    `${alerts}/:alertId/test`,
    { preHandler: [requireSiteScope(auth, 'admin'), requireLicense(state, ALERTS_FEATURE)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const site = request.site;
      if (site === null) {
        return unauthenticated(reply);
      }
      const params = alertParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(fail('INVALID_PARAMS', 'The alert id did not validate', params.error.issues));
      }
      const alert = await store.alert(site.id, params.data.alertId);
      if (alert === null) {
        return reply
          .code(404)
          .send(fail('ALERT_NOT_FOUND', `No alert ${params.data.alertId} belongs to ${site.id}`));
      }
      const deliveries = await notify(
        { store, deliver: ee.deliver, publicUrl: ee.publicUrl },
        site,
        alert,
        'test',
        null,
        deps.now(),
      );
      return reply.send(ok({ deliveries }));
    },
  );

  if (ee.tick) {
    // Started when the app is ready and stopped when it closes, so the seam
    // between the core and this package does not change and a test app that
    // never listens never ticks. Every process runs it; the claim on each
    // bucket is what makes that one evaluation per bucket, not one per process.
    let stop: (() => void) | null = null;
    app.addHook('onReady', async () => {
      stop = startAlertTick({
        store,
        deliver: ee.deliver,
        license: state,
        log: {
          info: (details, message) => app.log.info(details, message),
          warn: (details, message) => app.log.warn(details, message),
        },
        publicUrl: ee.publicUrl,
        now: deps.now,
      });
    });
    app.addHook('onClose', async () => {
      stop?.();
    });
  }
}
