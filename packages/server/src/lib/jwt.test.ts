import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { signHs256, verifyHs256 } from './jwt.js';

// A placeholder, never a real key: no secret belongs in this repository.
const SECRET = 'test-sso-secret-not-a-real-key-000000';
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const SECONDS = Math.floor(NOW / 1000);
const MAX_AGE = 300;

function token(claims: Record<string, unknown>, secret = SECRET): string {
  return signHs256(secret, claims);
}

function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('verifyHs256', () => {
  it('accepts a token it signed', () => {
    const result = verifyHs256(
      token({ sub: 'u_1', iat: SECONDS, exp: SECONDS + 300 }),
      SECRET,
      NOW,
      MAX_AGE,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.claims['sub']).toBe('u_1');
  });

  it('refuses a token signed with another secret', () => {
    const result = verifyHs256(
      token({ sub: 'u_1', iat: SECONDS, exp: SECONDS + 300 }, 'a-different-secret-entirely-00000'),
      SECRET,
      NOW,
      MAX_AGE,
    );
    expect(result).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('refuses a token whose payload was edited after signing', () => {
    const original = token({ sub: 'u_1', iat: SECONDS, exp: SECONDS + 300 });
    const [header, , signature] = original.split('.') as [string, string, string];
    const edited = `${header}.${part({ sub: 'u_admin', iat: SECONDS, exp: SECONDS + 300 })}.${signature}`;
    expect(verifyHs256(edited, SECRET, NOW, MAX_AGE)).toMatchObject({ code: 'BAD_SIGNATURE' });
  });

  // The classic JWT hole: a verifier that reads alg out of the header and does what
  // it is told accepts alg none, which is a token anybody can write.
  it('refuses alg none however well formed the rest is', () => {
    const header = part({ alg: 'none', typ: 'JWT' });
    const payload = part({ sub: 'u_admin', iat: SECONDS, exp: SECONDS + 300 });
    expect(verifyHs256(`${header}.${payload}.`, SECRET, NOW, MAX_AGE)).toMatchObject({
      code: 'UNSUPPORTED_ALGORITHM',
    });
  });

  it('refuses another algorithm even when the HMAC happens to match', () => {
    const header = part({ alg: 'HS512', typ: 'JWT' });
    const payload = part({ sub: 'u_1', iat: SECONDS, exp: SECONDS + 300 });
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(verifyHs256(`${header}.${payload}.${signature}`, SECRET, NOW, MAX_AGE)).toMatchObject({
      code: 'UNSUPPORTED_ALGORITHM',
    });
  });

  it('refuses a token that has run out', () => {
    expect(
      verifyHs256(token({ sub: 'u_1', iat: SECONDS - 600, exp: SECONDS - 1 }), SECRET, NOW, MAX_AGE),
    ).toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  // A five minute window is only five minutes if nobody can mint a token that says
  // it lasts a year.
  it('refuses a token that claims a longer life than the window allows', () => {
    expect(
      verifyHs256(
        token({ sub: 'u_1', iat: SECONDS, exp: SECONDS + 86_400 }),
        SECRET,
        NOW,
        MAX_AGE,
      ),
    ).toMatchObject({ code: 'TOKEN_TOO_LONG' });
  });

  it('refuses a token with no expiry at all', () => {
    expect(verifyHs256(token({ sub: 'u_1', iat: SECONDS }), SECRET, NOW, MAX_AGE)).toMatchObject({
      code: 'MISSING_EXPIRY',
    });
  });

  it('refuses a token issued in the future, which is the window stretched from the other end', () => {
    expect(
      verifyHs256(
        token({ sub: 'u_1', iat: SECONDS + 3600, exp: SECONDS + 3700 }),
        SECRET,
        NOW,
        MAX_AGE,
      ),
    ).toMatchObject({ code: 'TOKEN_NOT_YET_VALID' });
  });

  it('refuses something that is not a token', () => {
    expect(verifyHs256('not.a', SECRET, NOW, MAX_AGE)).toMatchObject({ code: 'MALFORMED_TOKEN' });
    expect(verifyHs256('', SECRET, NOW, MAX_AGE)).toMatchObject({ code: 'MALFORMED_TOKEN' });
  });

  // A token with no iat is treated as issued now, so a lifetime it does not declare
  // cannot be longer than the window.
  it('treats a missing iat as now rather than as unbounded', () => {
    expect(verifyHs256(token({ sub: 'u_1', exp: SECONDS + 60 }), SECRET, NOW, MAX_AGE).ok).toBe(
      true,
    );
    expect(
      verifyHs256(token({ sub: 'u_1', exp: SECONDS + 86_400 }), SECRET, NOW, MAX_AGE),
    ).toMatchObject({ code: 'TOKEN_TOO_LONG' });
  });
});
