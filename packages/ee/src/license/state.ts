import type { LicenseStatus } from '@chokh/server';

import { licenseAllows, type LicensePayload } from './payload.js';
import { verifyLicense, type LicenseRefusal } from './verify.js';

// What this install's licence is, asked once and re-read on every request.
//
// Two different costs, so two different cadences. Verifying a signature is
// arithmetic on a key that cannot change while the process runs, so it happens
// once. The expiry is a clock reading, so it happens every time: a key that
// runs out at midnight has to stop working at midnight, on a process that has
// been up for a month, without anybody restarting anything.

// Everything a route can be refused for, in the order they are discovered:
// there is no key at all, the key is not believable, or the key is fine and
// does not name this feature.
export type LicenseReason = 'missing' | LicenseRefusal | 'not_licensed';

export interface LicenseDecision {
  ok: boolean;
  reason?: LicenseReason;
}

export interface LicenseState {
  // Whether this install may run one feature, now.
  allows(feature: string, now: number): LicenseDecision;
  // What GET /api/license answers.
  status(now: number): LicenseStatus;
}

export interface LicenseStateInput {
  // The raw CHOKH_LICENSE_KEY, or nothing. Read once by env.ts.
  raw: string | undefined;
  // The build's public keys. Never anything from the environment.
  publicKeys: readonly string[];
}

const NO_LICENSE: LicenseStatus = {
  licensed: false,
  plan: null,
  licensee: null,
  expiresAt: null,
  features: [],
};

export function createLicenseState(input: LicenseStateInput): LicenseState {
  if (input.raw === undefined) {
    return {
      allows: () => ({ ok: false, reason: 'missing' }),
      status: () => NO_LICENSE,
    };
  }

  // Verified against a clock far enough in the past that expiry cannot be the
  // answer here: expiry is the one thing this function must not decide, because
  // it decides it once and the answer has to change later.
  const verified = verifyLicense(input.raw, { now: 0, publicKeys: input.publicKeys });
  if (!verified.ok) {
    const reason = verified.reason;
    return {
      allows: () => ({ ok: false, reason }),
      status: () => NO_LICENSE,
    };
  }

  const license: LicensePayload = verified.license;
  const expiresAtMs = license.expiresAt * 1000;
  const expired = (now: number): boolean => expiresAtMs <= now;

  return {
    allows(feature, now) {
      if (expired(now)) {
        return { ok: false, reason: 'expired' };
      }
      if (!licenseAllows(license, feature)) {
        return { ok: false, reason: 'not_licensed' };
      }
      return { ok: true };
    },

    status(now) {
      // The expiry and the licensee stay in the answer after a key runs out, on
      // purpose. "Chokh Pro expired on 20 September" and "you have never had a
      // licence" are different sentences, and a renewal and a purchase are
      // different conversations.
      return {
        licensed: !expired(now),
        plan: license.plan,
        licensee: license.licensee,
        expiresAt: expiresAtMs,
        features: expired(now) ? [] : [...license.features],
      };
    },
  };
}
