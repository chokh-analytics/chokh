import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ALL_FEATURES, licenseAllows, type LicensePayload } from './payload.js';
import { PUBLIC_KEYS } from './public-key.js';
import { encodePayload, publicKeyToBase64, signLicense, TOKEN_PREFIX } from './token.js';
import { verifyLicense } from './verify.js';

// The whole gate, and every way through it that has to be shut.
//
// The pair here is generated in memory for this run and is thrown away with the
// process. No key material of the product's own is in this repository, this
// image or any CI run: the private half of the real pair exists on the
// founder's machine and nowhere else, which is why verifyLicense takes the
// public keys as an argument rather than reaching for the baked-in list.

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const DAY = 86_400;

function pair(): { privateKey: string; publicKey: string } {
  const generated = generateKeyPairSync('ed25519');
  return {
    privateKey: generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKeyToBase64(
      generated.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    ),
  };
}

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    id: 'lic_test',
    licensee: 'A Test Company Ltd.',
    plan: 'pro',
    features: [ALL_FEATURES],
    seats: null,
    sites: null,
    issuedAt: Math.floor(NOW / 1000),
    expiresAt: Math.floor(NOW / 1000) + 365 * DAY,
    ...over,
  };
}

describe('verifyLicense', () => {
  it('accepts a key it was signed for, and reads it back whole', () => {
    const issuer = pair();
    const key = signLicense(issuer.privateKey, payload());

    const result = verifyLicense(key, { now: NOW, publicKeys: [issuer.publicKey] });

    expect(result.ok).toBe(true);
    expect(result.ok && result.license.licensee).toBe('A Test Company Ltd.');
    expect(result.ok && result.license.plan).toBe('pro');
    // The founder's decision, in the payload: per install, unlimited both ways,
    // the fields present so a later plan can use them.
    expect(result.ok && result.license.seats).toBeNull();
    expect(result.ok && result.license.sites).toBeNull();
  });

  // The build ships with no issuer, so an unbuilt install believes nobody. This
  // is what stops a stranger's key working on a public image before the founder
  // has put their own public key in the source.
  it('believes nobody when the build has no public key in it', () => {
    const issuer = pair();
    const key = signLicense(issuer.privateKey, payload());

    expect(verifyLicense(key, { now: NOW, publicKeys: [] })).toEqual({
      ok: false,
      reason: 'no_issuer',
    });
    // And that is the state of this build today, said out loud so that a commit
    // which quietly adds a key to the source has to change this line.
    expect(PUBLIC_KEYS).toEqual([]);
  });

  it('refuses a key signed by somebody else', () => {
    const issuer = pair();
    const stranger = pair();
    const key = signLicense(stranger.privateKey, payload());

    expect(verifyLicense(key, { now: NOW, publicKeys: [issuer.publicKey] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  // The point of the whole exercise: the payload cannot be edited after it is
  // signed. Somebody takes their own valid key, changes the expiry to ten years
  // out, and gets nothing.
  it('refuses a key whose payload was edited after signing', () => {
    const issuer = pair();
    const key = signLicense(issuer.privateKey, payload());
    const signature = key.split('.')[1] ?? '';
    const forged = `${TOKEN_PREFIX}${encodePayload(
      payload({ expiresAt: Math.floor(NOW / 1000) + 3650 * DAY }),
    )}.${signature}`;

    expect(verifyLicense(forged, { now: NOW, publicKeys: [issuer.publicKey] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a signature that was edited after signing', () => {
    const issuer = pair();
    const key = signLicense(issuer.privateKey, payload());
    const [head, signature = ''] = key.split('.');
    // One bit, in the middle, flipped on the decoded bytes. Editing the last
    // base64url character instead would sometimes change nothing at all: the
    // final character of a 64 byte signature carries two bits that decode to
    // nowhere, and a test that passes at random is worse than no test.
    const bytes = Buffer.from(signature, 'base64url');
    bytes[32] = (bytes[32] ?? 0) ^ 0x01;

    expect(
      verifyLicense(`${head}.${bytes.toString('base64url')}`, {
        now: NOW,
        publicKeys: [issuer.publicKey],
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a key that has run out', () => {
    const issuer = pair();
    const key = signLicense(issuer.privateKey, payload({ expiresAt: Math.floor(NOW / 1000) - 1 }));

    expect(verifyLicense(key, { now: NOW, publicKeys: [issuer.publicKey] })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  // The second on which it runs out, rather than a second later. A key that
  // works for one more request after its expiry is a key that works for one
  // more request after every expiry.
  it('refuses a key on the exact second it expires', () => {
    const issuer = pair();
    const expiresAt = Math.floor(NOW / 1000) + 60;
    const key = signLicense(issuer.privateKey, payload({ expiresAt }));

    expect(verifyLicense(key, { now: expiresAt * 1000 - 1, publicKeys: [issuer.publicKey] }).ok).toBe(
      true,
    );
    expect(verifyLicense(key, { now: expiresAt * 1000, publicKeys: [issuer.publicKey] })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  // A key from a later format is told apart from a corrupt one, because only
  // one of the two is worth an email back.
  it('refuses a key from a format this build does not know', () => {
    const issuer = pair();
    const key = signLicense(issuer.privateKey, { ...payload(), v: 2 } as unknown as LicensePayload);

    expect(verifyLicense(key, { now: NOW, publicKeys: [issuer.publicKey] })).toEqual({
      ok: false,
      reason: 'unknown_version',
    });
  });

  it('refuses a signed payload that is not the shape', () => {
    const issuer = pair();
    const key = signLicense(issuer.privateKey, { hello: 'there' } as unknown as LicensePayload);

    expect(verifyLicense(key, { now: NOW, publicKeys: [issuer.publicKey] })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it.each([
    ['empty', ''],
    ['not a Chokh key', 'eyJhbGciOiJIUzI1NiJ9.e30.x'],
    ['the marker and nothing else', TOKEN_PREFIX],
    ['one part', `${TOKEN_PREFIX}abc`],
    ['three parts', `${TOKEN_PREFIX}a.b.c`],
    ['an empty signature', `${TOKEN_PREFIX}abc.`],
    ['not base64url', `${TOKEN_PREFIX}!!!!.!!!!`],
  ])('refuses %s', (_name, raw) => {
    const issuer = pair();
    expect(verifyLicense(raw, { now: NOW, publicKeys: [issuer.publicKey] }).ok).toBe(false);
  });

  // Rotation: a build that accepts two public keys honours a key from either,
  // which is what lets a signing pair be replaced without breaking a key
  // somebody already paid for.
  it('accepts a key from any public key the build carries', () => {
    const retiring = pair();
    const current = pair();
    const old = signLicense(retiring.privateKey, payload({ id: 'lic_old' }));
    const fresh = signLicense(current.privateKey, payload({ id: 'lic_new' }));
    const both = [retiring.publicKey, current.publicKey];

    expect(verifyLicense(old, { now: NOW, publicKeys: both }).ok).toBe(true);
    expect(verifyLicense(fresh, { now: NOW, publicKeys: both }).ok).toBe(true);
    // And the day the old one is dropped, the old key stops.
    expect(verifyLicense(old, { now: NOW, publicKeys: [current.publicKey] }).ok).toBe(false);
  });
});

describe('licenseAllows', () => {
  it('lets a star key run a feature that did not exist when it was issued', () => {
    expect(licenseAllows(payload({ features: [ALL_FEATURES] }), 'something.new')).toBe(true);
  });

  it('holds a named key to what it names', () => {
    const named = payload({ features: ['alerts', 'digests'] });
    expect(licenseAllows(named, 'alerts')).toBe(true);
    expect(licenseAllows(named, 'replay')).toBe(false);
  });
});
