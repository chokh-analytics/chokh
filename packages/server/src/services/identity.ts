import { verifyUserId } from '../lib/identity-signature.js';
import type { CollectBatch } from '../schemas/collect.schema.js';
import type { Site } from '../store/AnalyticsStore.js';

// Whether the collector believes who a batch says its visitor is.
//
// An identity is confirmed when its signature verifies, or when there is no
// signature and the site accepts an unsigned identify. A signature that is
// present and wrong is never confirmed, whatever the site's setting says: an
// absent signature is a site that never signs, a wrong one is an attempt.
//
// Nothing else in the collector reads batch.userId. What is not confirmed
// never becomes a userId on an event, never reaches a visitor row, never
// merges an anonymous history and therefore never answers a per-user lookup.

export type IdentityVerdict =
  | { kind: 'anonymous' }
  | { kind: 'confirmed'; userId: string }
  | { kind: 'refused'; userId: string; reason: 'bad_signature' | 'unsigned' };

export function confirmIdentity(site: Site, batch: CollectBatch): IdentityVerdict {
  const userId = batch.userId ?? batch.events.find((event) => event.userId !== undefined)?.userId;
  if (userId === undefined) {
    return { kind: 'anonymous' };
  }
  if (batch.sig !== undefined && batch.sig !== '') {
    return verifyUserId(site.settings.identifySecret, site.id, userId, batch.sig)
      ? { kind: 'confirmed', userId }
      : { kind: 'refused', userId, reason: 'bad_signature' };
  }
  return site.settings.allowUnsignedIdentify
    ? { kind: 'confirmed', userId }
    : { kind: 'refused', userId, reason: 'unsigned' };
}
