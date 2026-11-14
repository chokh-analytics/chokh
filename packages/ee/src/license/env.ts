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
// string every mail provider documents; CHOKH_BREVO_API_KEY is the other way
// to send email, over HTTPS through Brevo's API, for a host whose outbound
// SMTP ports are closed (DigitalOcean closes 25, 465 and 587 by default, and
// the Progsity droplet is one); when both are set the API is used.
// CHOKH_MAIL_FROM is the address the messages come from, and email needs it
// whichever way it goes. CHOKH_TELEGRAM_BOT_TOKEN is the token BotFather hands
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
  CHOKH_BREVO_API_KEY: optional,
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
  brevoApiKey: string | undefined;
  mailFrom: string | undefined;
  telegramBotToken: string | undefined;
  publicUrl: string | undefined;
}

export function readDeliveryEnv(source: NodeJS.ProcessEnv = process.env): DeliveryEnv {
  const parsed = deliverySchema.parse({
    CHOKH_SMTP_URL: source['CHOKH_SMTP_URL'],
    CHOKH_BREVO_API_KEY: source['CHOKH_BREVO_API_KEY'],
    CHOKH_MAIL_FROM: source['CHOKH_MAIL_FROM'],
    CHOKH_TELEGRAM_BOT_TOKEN: source['CHOKH_TELEGRAM_BOT_TOKEN'],
    CHOKH_PUBLIC_URL: source['CHOKH_PUBLIC_URL'],
  });
  return {
    smtpUrl: parsed.CHOKH_SMTP_URL,
    brevoApiKey: parsed.CHOKH_BREVO_API_KEY,
    mailFrom: parsed.CHOKH_MAIL_FROM,
    telegramBotToken: parsed.CHOKH_TELEGRAM_BOT_TOKEN,
    publicUrl: parsed.CHOKH_PUBLIC_URL,
  };
}

// Signing in through an OpenID Connect provider (AN-TEAM01). Four values and
// all four or nothing: the issuer, this install's client id and secret at
// that issuer, and the address this install is reached at, which is where the
// provider sends a browser back to. That address is configuration and never
// a request's Host header, which is the caller's to write.
//
// Read here and nowhere else. The client secret goes from the environment to
// the one request that exchanges a code, and is never stored, logged, shown
// or handed to the dashboard.
const oidcIssuer = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ''))
    .optional(),
);

export interface OidcEnv {
  issuer: string;
  clientId: string;
  clientSecret: string;
  publicUrl: string;
}

// The configuration when all of it is there, or the names of the variables
// that are missing. Names only: a boot line may say which variable to set and
// never what one held.
export function readOidcEnv(
  source: NodeJS.ProcessEnv = process.env,
): { config: OidcEnv } | { missing: string[] } {
  // Each on its own: an issuer that is not an address is that one value
  // missing, and says nothing about the other three.
  const issuer = oidcIssuer.safeParse(source['CHOKH_OIDC_ISSUER']);
  const values = {
    CHOKH_OIDC_ISSUER: issuer.success ? issuer.data : undefined,
    CHOKH_OIDC_CLIENT_ID: optional.parse(source['CHOKH_OIDC_CLIENT_ID']),
    CHOKH_OIDC_CLIENT_SECRET: optional.parse(source['CHOKH_OIDC_CLIENT_SECRET']),
  };
  const publicUrl = readDeliveryEnv(source).publicUrl;
  const missing = [
    ['CHOKH_OIDC_ISSUER', values.CHOKH_OIDC_ISSUER],
    ['CHOKH_OIDC_CLIENT_ID', values.CHOKH_OIDC_CLIENT_ID],
    ['CHOKH_OIDC_CLIENT_SECRET', values.CHOKH_OIDC_CLIENT_SECRET],
    ['CHOKH_PUBLIC_URL', publicUrl],
  ]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name as string);
  if (
    missing.length > 0 ||
    values.CHOKH_OIDC_ISSUER === undefined ||
    values.CHOKH_OIDC_CLIENT_ID === undefined ||
    values.CHOKH_OIDC_CLIENT_SECRET === undefined ||
    publicUrl === undefined
  ) {
    return { missing };
  }
  return {
    config: {
      issuer: values.CHOKH_OIDC_ISSUER,
      clientId: values.CHOKH_OIDC_CLIENT_ID,
      clientSecret: values.CHOKH_OIDC_CLIENT_SECRET,
      publicUrl,
    },
  };
}
