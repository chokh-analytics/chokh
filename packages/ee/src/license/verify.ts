import { licensePayloadSchema, type LicensePayload } from './payload.js';
import { TOKEN_PREFIX, verifySignature } from './token.js';

// Offline, and only offline.
//
// Nothing here opens a socket, and nothing here ever will. A self-hoster chose
// this product because it does not tell anybody who reads their dashboard, and
// a licence check that called home would be the one request in the whole
// install that reported on the install itself. So the key carries everything
// the check needs, the build carries the public keys, and the answer is a
// signature comparison and a clock reading.

export type LicenseRefusal =
  // No issuer in this build: PUBLIC_KEYS is empty, so no key can be believed.
  | 'no_issuer'
  // Not a Chokh key, or not two parts, or not JSON, or not the shape.
  | 'malformed'
  // A key from a later format. Refused rather than read hopefully.
  | 'unknown_version'
  // Nobody holding a private key this build accepts signed this.
  | 'bad_signature'
  | 'expired';

export type LicenseVerification =
  | { ok: true; license: LicensePayload }
  | { ok: false; reason: LicenseRefusal };

export interface VerifyOptions {
  // Unix milliseconds, injected, so a test can stand anywhere on the clock and
  // so the guard can re-read the time on every request without re-verifying.
  now: number;
  // The public keys to believe. The server passes PUBLIC_KEYS; a test passes a
  // pair it generated. Nothing passes anything it read from the environment.
  publicKeys: readonly string[];
}

function refuse(reason: LicenseRefusal): LicenseVerification {
  return { ok: false, reason };
}

export function verifyLicense(raw: string, options: VerifyOptions): LicenseVerification {
  if (options.publicKeys.length === 0) {
    return refuse('no_issuer');
  }
  if (!raw.startsWith(TOKEN_PREFIX)) {
    return refuse('malformed');
  }
  const parts = raw.slice(TOKEN_PREFIX.length).split('.');
  if (parts.length !== 2) {
    return refuse('malformed');
  }
  const [payloadSegment, signatureSegment] = parts as [string, string];
  if (payloadSegment === '' || signatureSegment === '') {
    return refuse('malformed');
  }

  // The signature first, before a byte of the payload is believed. Everything
  // after this point is reading a document somebody we trust wrote; everything
  // before it is reading a string a stranger typed.
  const signed = options.publicKeys.some((publicKey) =>
    verifySignature(payloadSegment, signatureSegment, publicKey),
  );
  if (!signed) {
    return refuse('bad_signature');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return refuse('malformed');
  }

  // Version before shape, so a key from a later format is told apart from a
  // corrupt one. Both are refused; only one of them is worth an email.
  const version = (decoded as { v?: unknown } | null)?.v;
  if (typeof version === 'number' && version !== 1) {
    return refuse('unknown_version');
  }

  const parsed = licensePayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    return refuse('malformed');
  }
  // Seconds in the key, milliseconds on the clock.
  if (parsed.data.expiresAt * 1000 <= options.now) {
    return refuse('expired');
  }

  return { ok: true, license: parsed.data };
}
