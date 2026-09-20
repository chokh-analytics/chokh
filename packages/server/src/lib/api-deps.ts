import type { LicenseStatusProvider } from '../plugins/extensions.js';
import type { Bus } from '../services/bus.js';
import type { OnceOnly } from '../services/once.js';
import type { SessionCodec } from '../services/auth.service.js';
import type { AccountStore, AnalyticsStore } from '../store/AnalyticsStore.js';
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
  limits: { authAttempts: number };
  cookie: { secure: boolean };
  sso: { secret: string | undefined; maxAgeSeconds: number };
  // What GET /api/license answers. The extension's when packages/ee is loaded,
  // and "no licence" when it is not. The core never reads a key to build it.
  license: LicenseStatusProvider;
  now(): number;
}
