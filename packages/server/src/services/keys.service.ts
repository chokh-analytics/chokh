import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AccountStore, Scope, StoredApiKey } from '../store/AnalyticsStore.js';

// API keys: minted once, shown once, stored as a hash.
//
// The hash is SHA-256 and not argon2, and the reason is worth writing down
// because it reads like a mistake. A password is a short thing a person chose,
// so it can be guessed and needs a hash slow enough to make guessing expensive.
// A key is 256 bits from the system random source: there is nothing to guess, so
// the only job left is that a stolen database does not hand over working keys,
// and one round of SHA-256 does that. It also has to be looked up by hash on
// every request, through a unique index, which a salted slow hash cannot be.

const KEY_PREFIX = 'chk_';
const KEY_BYTES = 32;

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface MintedKey {
  record: StoredApiKey;
  // The only time this exists. Shown in the create response and never stored,
  // so a key that was lost is replaced rather than recovered.
  token: string;
}

export function mintApiKey(input: {
  siteId: string;
  name: string;
  scopes: Scope[];
  createdBy: string;
  now: number;
}): MintedKey {
  const token = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;
  return {
    token,
    record: {
      id: `k_${randomUUID()}`,
      siteId: input.siteId,
      name: input.name,
      keyHash: hashApiKey(token),
      scopes: input.scopes,
      createdAt: input.now,
      createdBy: input.createdBy,
    },
  };
}

export async function createApiKey(
  store: AccountStore,
  input: Parameters<typeof mintApiKey>[0],
): Promise<MintedKey> {
  const minted = mintApiKey(input);
  await store.createApiKey(minted.record);
  return minted;
}
