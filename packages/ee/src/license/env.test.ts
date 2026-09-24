import { describe, expect, it } from 'vitest';

import { readDeliveryEnv, readLicenseKey } from './env.js';

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
