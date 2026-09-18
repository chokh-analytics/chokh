import { createHmac, timingSafeEqual } from 'node:crypto';

// The smallest correct HS256 verifier, for the SSO exchange and nothing else.
//
// The token an application hands over is a JWT because that is what every
// backend can already sign: three base64url parts, the third an HMAC-SHA256 of
// the first two joined by a dot, under a secret the two sides share. There is no
// library here because there is nothing to abstract: one algorithm, allowed by
// name and never read from the header, and no key resolution.
//
// Reading `alg` out of the header and trusting it is the classic JWT hole (alg
// "none", or an RSA public key replayed as an HMAC secret), so this asserts the
// header says HS256 rather than asking it what to do.

export interface JwtVerification {
  ok: true;
  claims: Record<string, unknown>;
}

export interface JwtRefusal {
  ok: false;
  code: string;
  message: string;
}

export type JwtResult = JwtVerification | JwtRefusal;

function refuse(code: string, message: string): JwtRefusal {
  return { ok: false, code, message };
}

function decodePart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function signHs256(secret: string, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
}

// Signature, algorithm and expiry, in that order. The caller checks the claims
// it cares about; this only proves the token was issued by somebody holding the
// secret and has not run out.
//
// maxAgeSeconds bounds how long a token may claim to live. A five minute window
// is only five minutes if nobody can mint a token that says it lasts a year, so
// an exp further than this from iat is refused however well it is signed.
export function verifyHs256(
  token: string,
  secret: string,
  now: number,
  maxAgeSeconds: number,
): JwtResult {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return refuse('MALFORMED_TOKEN', 'A token has three dot separated parts');
  }
  const [header, payload, signature] = parts as [string, string, string];

  const head = decodePart(header);
  if (!isObject(head) || head['alg'] !== 'HS256') {
    return refuse('UNSUPPORTED_ALGORITHM', 'Only HS256 is accepted');
  }

  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const given = Buffer.from(signature);
  const mine = Buffer.from(expected);
  // Constant time, because a check that leaks how far it got is a check
  // somebody can walk through one character at a time.
  if (mine.length !== given.length || !timingSafeEqual(mine, given)) {
    return refuse('BAD_SIGNATURE', 'The token signature does not match');
  }

  const claims = decodePart(payload);
  if (!isObject(claims)) {
    return refuse('MALFORMED_TOKEN', 'The token payload is not an object');
  }

  const exp = claims['exp'];
  if (typeof exp !== 'number') {
    return refuse('MISSING_EXPIRY', 'A token has to say when it expires');
  }
  const seconds = Math.floor(now / 1000);
  if (exp <= seconds) {
    return refuse('TOKEN_EXPIRED', 'The token has expired');
  }
  const iat = claims['iat'];
  const issued = typeof iat === 'number' ? iat : seconds;
  if (exp - issued > maxAgeSeconds) {
    return refuse(
      'TOKEN_TOO_LONG',
      `A token may not live longer than ${maxAgeSeconds} seconds`,
    );
  }
  // A token issued in the future is either a clock that is wrong or somebody
  // stretching the window from the other end.
  if (issued > seconds + 60) {
    return refuse('TOKEN_NOT_YET_VALID', 'The token was issued in the future');
  }

  return { ok: true, claims };
}
