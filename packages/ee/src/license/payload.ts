import { z } from 'zod';

// What a Chokh licence key says.
//
// It is deliberately short. Everything in here has to be true offline, for ever,
// with no way to ask anybody anything, so a field that cannot be checked without
// a network is a field that does not belong. That is why there is no install id
// and no machine fingerprint: either the issuer would have to know the install
// before issuing (they do not), or the install would have to report itself,
// which is a call home wearing a different hat. A privacy product that phones
// home has failed at the one thing it promised.
//
// seats and sites are here and are null on every key the first plan issues.
// Chokh Pro is per install: one company, one server, one key, with as many
// sites and as many people on it as they like. The fields exist so a later plan
// can use them without a format change, and the verifier reads them today so
// that a key which names them is never silently ignored.

// The only version this build understands. A key from the future is refused
// rather than read hopefully: a field that changed meaning between versions is
// exactly the thing a hopeful reader gets wrong.
export const LICENSE_VERSION = 1;

// The feature name that means every feature, for the founder's own key and for
// a plan that gates nothing.
export const ALL_FEATURES = '*';

export const licensePayloadSchema = z.object({
  v: z.literal(LICENSE_VERSION),
  // The licence's own id, so a key can be named in an invoice, in a support
  // thread and one day in a revocation list.
  id: z.string().min(1),
  // Shown to signed-in people in the dashboard, so they can tell whose key this
  // install is running on.
  licensee: z.string().min(1),
  // The tier, for display. One tier today, called pro.
  plan: z.string().min(1),
  features: z.array(z.string().min(1)).min(1),
  // Unlimited on every key the first plan issues. A number here is a promise
  // this verifier does not police: nothing offline can count the people using a
  // dashboard honestly, and a check that can be wrong is worse than no check.
  seats: z.number().int().positive().nullable(),
  sites: z.number().int().positive().nullable(),
  // Unix seconds, both. Seconds rather than milliseconds because the key is
  // read by people as well as by programs and three zeroes help nobody.
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});

export type LicensePayload = z.infer<typeof licensePayloadSchema>;

// Whether a key covers one feature. A key that names ALL_FEATURES covers
// everything, including features that did not exist when it was issued, which
// is what makes a two year key worth buying.
export function licenseAllows(license: LicensePayload, feature: string): boolean {
  return license.features.includes(ALL_FEATURES) || license.features.includes(feature);
}
