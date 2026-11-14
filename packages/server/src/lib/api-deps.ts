import type { LicenseStatusProvider } from '../plugins/extensions.js';
import type { Bus } from '../services/bus.js';
import type { OnceOnly } from '../services/once.js';
import type { SessionCodec } from '../services/auth.service.js';
import type { ShareCodec } from '../services/share.service.js';
import type { AccountStore, AnalyticsStore } from '../store/AnalyticsStore.js';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { AuditCursorCodec } from './audit-cursor.js';
import type { Sealer } from './seal.js';
import type { WindowCounter } from './window-counter.js';

// Everything the API routes are handed, in one place, so app.ts builds it once
// and no controller reaches for a module-level singleton. The collector's
// CollectDeps is the same idea for the same reason.
export interface ApiDeps {
  store: AnalyticsStore & AccountStore;
  session: SessionCodec;
  // The nudge that wakes a realtime stream when a batch lands.
  bus: Bus;
  // The set that stops an SSO token being exchanged twice.
  once: OnceOnly;
  // Sign-in attempts a minute, per address.
  authLimit: WindowCounter;
  // Reads of a public share per address a minute, on their own counter.
  shareLimit: WindowCounter;
  // Looking up and accepting an invitation, per address a minute, on a
  // counter of their own so a sign-in and an invitation do not share a limit.
  inviteLimit: WindowCounter;
  shareCodec: ShareCodec;
  // Signs the audit log's cursor, so a page is only ever carried on from a
  // listing whose opening was recorded.
  auditCursor: AuditCursorCodec;
  // A sealer for one named purpose, keyed from the session secret: a cookie a
  // browser carries for a few minutes and can neither read nor change. For an
  // extension that sends a browser away and has to recognise it coming back.
  seal(purpose: string): Sealer;
  // Limits by address, for an extension.
  //
  // `invitation` is the hook the core's own invitation routes use, on their
  // counter: using an invitation by any route counts against one count.
  //
  // `count` is a count of the extension's own, taken when the extension
  // chooses and not before: one more for this request's address in the named
  // bucket, and whether that is still within the limit. Never the password
  // route's counter. A route that any page can make a browser request must
  // not be able to use up the attempts somebody has left to sign in with
  // their password, so there is no way to count against those from here.
  attempts: {
    invitation: preHandlerHookHandler;
    count(request: FastifyRequest, bucket: string, limit: number): boolean;
  };
  // A stand-in for an id that says who somebody is, for a caller who may not
  // be told: the same for the same id every time, and not turned back without
  // the server's secret.
  auditStandIn(id: string): string;
  limits: { authAttempts: number; shareReads: number };
  cookie: { secure: boolean };
  sso: { secret: string | undefined; maxAgeSeconds: number };
  // How long an invitation lives, in milliseconds.
  invites: { ttlMs: number };
  // What GET /api/license answers. The extension's when packages/ee is loaded,
  // and "no licence" when it is not. The core never reads a key to build it.
  license: LicenseStatusProvider;
  now(): number;
}
