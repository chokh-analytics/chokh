import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// A value put in a browser's cookie for a few minutes and taken back, which
// the browser can neither read nor change.
//
// The session cookie is signed and not sealed, because what it carries is not
// a secret from the person carrying it. This is for the other kind of cookie:
// the short one a sign-in through an outside identity provider leaves behind
// while the browser is away at the provider, which holds what has to match on
// the way back and one value (the PKCE verifier) that is the proof this
// browser began the flow. Sealed, so nothing that can read a cookie jar learns
// it, and so a cookie that was not made here opens as nothing.
//
// AES-256-GCM, a fresh nonce for every seal, and a key derived from the
// session secret for one named purpose: a value sealed for one purpose does
// not open as another, and nothing sealed here could ever be read as a
// session. The expiry is inside the seal, so a cookie kept past its minutes
// opens as nothing whatever the browser did with its own max-age.

export interface Sealer {
  seal(value: unknown, ttlMs: number, now: number): string;
  // What was sealed, or null for anything that was not sealed here for this
  // purpose, was changed, or has run out.
  open(text: string | undefined, now: number): unknown;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function createSealer(secret: string, purpose: string): Sealer {
  const key = createHmac('sha256', secret).update(`chokh seal v1\n${purpose}`).digest();
  return {
    seal(value: unknown, ttlMs: number, now: number): string {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([
        cipher.update(JSON.stringify({ v: value, exp: now + ttlMs }), 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
    },

    open(text: string | undefined, now: number): unknown {
      if (text === undefined || text === '') {
        return null;
      }
      const raw = Buffer.from(text, 'base64url');
      if (raw.length <= NONCE_BYTES + TAG_BYTES) {
        return null;
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE_BYTES));
        decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
        const plain = Buffer.concat([
          decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)),
          decipher.final(),
        ]).toString('utf8');
        const parsed = JSON.parse(plain) as { v?: unknown; exp?: unknown };
        if (typeof parsed.exp !== 'number' || parsed.exp <= now) {
          return null;
        }
        return parsed.v ?? null;
      } catch {
        // Not sealed here, sealed for another purpose, or changed on the way.
        return null;
      }
    },
  };
}
