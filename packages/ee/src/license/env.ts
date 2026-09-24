import { z } from 'zod';

// The only place in the repository that reads CHOKH_LICENSE_KEY, and the one
// reader this package has for everything else it needs from the environment.
//
// It is here and not in packages/server/src/config/env.ts because the core
// never reads the licence key (ADR-0073 decision 4): a declaration there would
// be the crossing the rule exists to stop, and review refuses one from this
// ticket on. The repository rule that each package has exactly one environment
// reader still holds (AGENTS.md rule 12); this package has its own, validated
// the same way.
//
// Empty is treated as unset. A compose file or a deploy script that writes
// CHOKH_LICENSE_KEY= with nothing after it means "no key", and reading that as
// a malformed key would tell an honest operator they had done something wrong.

const optional = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const schema = z.object({
  CHOKH_LICENSE_KEY: optional,
});

export function readLicenseKey(source: NodeJS.ProcessEnv = process.env): string | undefined {
  return schema.parse({ CHOKH_LICENSE_KEY: source['CHOKH_LICENSE_KEY'] }).CHOKH_LICENSE_KEY;
}

// Where the paid features send things. All optional: an install that sets none
// of them can still keep alerts, and is told at create time which channels it
// cannot send on rather than finding out on the night of the outage.
//
// CHOKH_SMTP_URL is smtp://user:pass@host:port or smtps://..., which is the one
// string every mail provider documents; CHOKH_MAIL_FROM is the address the
// messages come from. CHOKH_TELEGRAM_BOT_TOKEN is the token BotFather hands
// out; the chat a message goes to is on the alert. CHOKH_PUBLIC_URL is where
// this dashboard is reached from outside, so a message can carry a link.
const deliverySchema = z.object({
  CHOKH_SMTP_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .url()
      .refine((value) => /^smtps?:\/\//.test(value), 'CHOKH_SMTP_URL starts with smtp:// or smtps://')
      .optional(),
  ),
  CHOKH_MAIL_FROM: optional,
  CHOKH_TELEGRAM_BOT_TOKEN: optional,
  CHOKH_PUBLIC_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .url()
      .refine((value) => /^https?:\/\//.test(value), 'CHOKH_PUBLIC_URL starts with http:// or https://')
      .transform((value) => value.replace(/\/+$/, ''))
      .optional(),
  ),
});

export interface DeliveryEnv {
  smtpUrl: string | undefined;
  mailFrom: string | undefined;
  telegramBotToken: string | undefined;
  publicUrl: string | undefined;
}

export function readDeliveryEnv(source: NodeJS.ProcessEnv = process.env): DeliveryEnv {
  const parsed = deliverySchema.parse({
    CHOKH_SMTP_URL: source['CHOKH_SMTP_URL'],
    CHOKH_MAIL_FROM: source['CHOKH_MAIL_FROM'],
    CHOKH_TELEGRAM_BOT_TOKEN: source['CHOKH_TELEGRAM_BOT_TOKEN'],
    CHOKH_PUBLIC_URL: source['CHOKH_PUBLIC_URL'],
  });
  return {
    smtpUrl: parsed.CHOKH_SMTP_URL,
    mailFrom: parsed.CHOKH_MAIL_FROM,
    telegramBotToken: parsed.CHOKH_TELEGRAM_BOT_TOKEN,
    publicUrl: parsed.CHOKH_PUBLIC_URL,
  };
}
