import { describe, expect, it } from 'vitest';

import { readDeliveryEnv, readLicenseKey, readOidcEnv } from './env.js';

// The one reader this package has. Empty means unset, a bad URL is refused at
// boot rather than at the moment somebody needed a message, and a trailing
// slash on the public URL is dropped so a link never reads //.

describe('readLicenseKey', () => {
  it('reads an empty key as no key', () => {
    expect(readLicenseKey({ CHOKH_LICENSE_KEY: '' })).toBeUndefined();
    expect(readLicenseKey({})).toBeUndefined();
    expect(readLicenseKey({ CHOKH_LICENSE_KEY: 'CHOKH-a.b' })).toBe('CHOKH-a.b');
  });
});

describe('readDeliveryEnv', () => {
  it('reads nothing set as nothing', () => {
    expect(readDeliveryEnv({})).toEqual({
      smtpUrl: undefined,
      brevoApiKey: undefined,
      mailFrom: undefined,
      telegramBotToken: undefined,
      publicUrl: undefined,
    });
    expect(readDeliveryEnv({ CHOKH_SMTP_URL: '', CHOKH_MAIL_FROM: '', CHOKH_TELEGRAM_BOT_TOKEN: '', CHOKH_PUBLIC_URL: '' })).toEqual({
      smtpUrl: undefined,
      brevoApiKey: undefined,
      mailFrom: undefined,
      telegramBotToken: undefined,
      publicUrl: undefined,
    });
  });

  it('keeps what was set, and trims the slash off the public URL', () => {
    expect(
      readDeliveryEnv({
        CHOKH_SMTP_URL: 'smtps://user:pass@smtp-relay.example.test:465',
        CHOKH_MAIL_FROM: 'chokh@example.test',
        CHOKH_TELEGRAM_BOT_TOKEN: '123:abc',
        CHOKH_PUBLIC_URL: 'https://analytics.example.test/',
      }),
    ).toEqual({
      smtpUrl: 'smtps://user:pass@smtp-relay.example.test:465',
      brevoApiKey: undefined,
      mailFrom: 'chokh@example.test',
      telegramBotToken: '123:abc',
      publicUrl: 'https://analytics.example.test',
    });
  });

  it('refuses an SMTP URL or a public URL of the wrong scheme', () => {
    expect(() => readDeliveryEnv({ CHOKH_SMTP_URL: 'https://mail.example.test' })).toThrow(/smtp/);
    expect(() => readDeliveryEnv({ CHOKH_SMTP_URL: 'not a url' })).toThrow();
    expect(() => readDeliveryEnv({ CHOKH_PUBLIC_URL: 'analytics.example.test' })).toThrow();
  });
});

// Signing in through an identity provider is four values, all of them or it
// is off, and what is said about the ones that are missing is their names.
describe('readOidcEnv', () => {
  const ALL = {
    CHOKH_OIDC_ISSUER: 'https://id.example.test/',
    CHOKH_OIDC_CLIENT_ID: 'a-client',
    CHOKH_OIDC_CLIENT_SECRET: 'an-invented-secret-for-a-test',
    CHOKH_PUBLIC_URL: 'https://analytics.example.test/',
  };

  // The issuer is a name that is compared character for character with what
  // the provider says of itself, and some providers' names end in a slash.
  it('reads all four, the issuer exactly as it is written and the public address without its slash', () => {
    expect(readOidcEnv({ ...ALL, CHOKH_OIDC_ISSUER: 'https://id.example.test' })).toMatchObject({
      config: { issuer: 'https://id.example.test' },
    });
    expect(readOidcEnv(ALL)).toEqual({
      config: {
        issuer: 'https://id.example.test/',
        clientId: 'a-client',
        clientSecret: 'an-invented-secret-for-a-test',
        publicUrl: 'https://analytics.example.test',
      },
    });
  });

  it('is off with any one missing, and names it without repeating a value', () => {
    for (const name of Object.keys(ALL) as (keyof typeof ALL)[]) {
      const read = readOidcEnv({ ...ALL, [name]: '' });
      expect(read).toEqual({ missing: [name] });
      expect(JSON.stringify(read)).not.toContain('an-invented-secret-for-a-test');
    }
    expect(readOidcEnv({})).toEqual({
      missing: ['CHOKH_OIDC_ISSUER', 'CHOKH_OIDC_CLIENT_ID', 'CHOKH_OIDC_CLIENT_SECRET', 'CHOKH_PUBLIC_URL'],
    });
  });

  it('reads an issuer that is not an address as missing', () => {
    expect(readOidcEnv({ ...ALL, CHOKH_OIDC_ISSUER: 'id.example.test' })).toEqual({
      missing: ['CHOKH_OIDC_ISSUER'],
    });
  });
});
