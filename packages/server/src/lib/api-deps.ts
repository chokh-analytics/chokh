import type { LicenseStatusProvider } from '../plugins/extensions.js';
import type { Bus } from '../services/bus.js';
import type { OnceOnly } from '../services/once.js';
import type { SessionCodec } from '../services/auth.service.js';
import type { ShareCodec } from '../services/share.service.js';
import type { AccountStore, AnalyticsStore } from '../store/AnalyticsStore.js';
import type { preHandlerHookHandler } from 'fastify';

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
  // The limits by address as hooks, on the counters the core's own routes
  // use: signing in by any route counts against one count, and so does using
  // an invitation by any route.
  attempts: { signIn: preHandlerHookHandler; invitation: preHandlerHookHandler };
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
