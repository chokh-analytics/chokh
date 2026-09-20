import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import type { LicensePayload } from './payload.js';

// The key's wire format, and the two halves of Ed25519 around it.
//
//   CHOKH-<base64url of the payload JSON>.<base64url of the signature>
//
// One string somebody can paste into an environment variable, read back out of
// one, and recognise on sight. Not a JWT: there is nothing here to
// interoperate with, and a JWT would invite reading the algorithm out of the
// header, which is the classic hole this repository already wrote a verifier
// to refuse. There is one algorithm, it is named in the code, and it is never
// read from the token.
//
// The signature covers the whole prefixed segment, so neither the payload nor
// the marker in front of it can be swapped for another key's.

export const TOKEN_PREFIX = 'CHOKH-';

export function signedBytes(payloadSegment: string): Buffer {
  return Buffer.from(`${TOKEN_PREFIX}${payloadSegment}`, 'utf8');
}

export function encodePayload(payload: LicensePayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// Used by the chokh-license CLI and by tests, each with a key of their own.
// Never by the server: a process that can sign a licence is a process that does
// not need one.
export function signLicense(privateKeyPem: string, payload: LicensePayload): string {
  const key = createPrivateKey(privateKeyPem);
  const segment = encodePayload(payload);
  const signature = sign(null, signedBytes(segment), key).toString('base64url');
  return `${TOKEN_PREFIX}${segment}.${signature}`;
}

// A public key as it is written down: base64 of the DER SPKI encoding, which is
// what a PEM body is without its header lines. One line, safe to commit, safe
// to print, and useless to anybody who wants to mint a key.
export function publicKeyFromBase64(base64: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
}

export function publicKeyToBase64(publicKeyPem: string): string {
  return createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' }).toString('base64');
}

export function verifySignature(
  payloadSegment: string,
  signatureSegment: string,
  publicKeyBase64: string,
): boolean {
  try {
    return verify(
      null,
      signedBytes(payloadSegment),
      publicKeyFromBase64(publicKeyBase64),
      Buffer.from(signatureSegment, 'base64url'),
    );
  } catch {
    // A public key this build cannot parse, or a signature that is not
    // base64url. Both are "no" rather than a crash: the caller is holding a
    // string somebody typed.
    return false;
  }
}
