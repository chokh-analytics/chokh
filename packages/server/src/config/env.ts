// Validated environment. Nothing else in the server reads process.env.
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

// A compose file or a shell hands over an empty string for a variable nobody
// set, which means unset and not "a value of zero length".
const optional = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Where the built dashboard lives. Unset means "the sibling package's dist",
  // which is what a workspace checkout wants; the image sets it explicitly.
  DASHBOARD_DIR: optional,
  // Where the rows go. Unset means the in-memory adapter, which keeps nothing
  // across a restart and is never a deployment.
  MONGODB_URI: optional,
  // Where "who is here now" is kept. Unset means a map in this process, which
  // is a complete install on one container; set it and every process of an
  // install counts the same visitors. Losing Redis costs a minute of the
  // online count and nothing else, because presence is never storage.
  REDIS_URL: optional,

  // Who may tell the collector a visitor's real address, and in which header.
  // Without TRUST_PROXY nothing is believed and the socket's peer is the
  // visitor, which is right for a collector reached directly.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? []
        : value
            .split(',')
            .map((cidr) => cidr.trim())
            .filter((cidr) => cidr !== ''),
    ),
  REAL_IP_HEADER: z
    .string()
    .transform((value) => (value === '' ? 'X-Forwarded-For' : value))
    .default('X-Forwarded-For')
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(['x-forwarded-for', 'cf-connecting-ip', 'x-chokh-forwarded-for'])),

  // The secret a first-party proxy signs a forwarded address with, shared with
  // that proxy and never with a browser. It is what the x-chokh-forwarded-for
  // mode believes instead of a peer range, so the mode without it is refused at
  // boot by the refine below rather than trusting everybody who sets a header.
  CHOKH_PROXY_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32, 'A proxy secret needs at least 32 characters').optional(),
  ),

  // Where the geo database lives, and the MaxMind key that chooses
  // GeoLite2-City over the keyless DB-IP Lite fallback.
  GEOIP_DIR: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).default('./data/geo')),
  GEOIP_LICENSE_KEY: optional,

  // Batches a minute, per address and per site.
  //
  // One address is not one person. A university lab, an office or a mobile
  // carrier puts thousands of visitors behind one NAT address, and a single
  // open tab posts a batch on every heartbeat, three a minute. The per-address
  // default therefore has to hold about a thousand tabs on one address, or a
  // campus loses every batch after the limit to a 429. Lower it only for a site
  // whose visitors are known to arrive one address each.
  COLLECT_RATE_LIMIT_IP: z.coerce.number().int().positive().default(3000),
  COLLECT_RATE_LIMIT_SITE: z.coerce.number().int().positive().default(60000),

  // What a dashboard session cookie is signed with. There is no session table:
  // the cookie carries the user id and an expiry, and this is what makes it
  // unforgeable. Required in production, because a generated one would be
  // different in every process and after every restart, which on one container
  // means everybody is signed out by a deploy and on two means half the requests
  // are.
  SESSION_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32, 'A session secret needs at least 32 characters').optional(),
  ),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(12),

  // The secret another application signs an SSO token with. Unset means this
  // install has no SSO and POST /api/sso refuses everything, which is the right
  // default: an SSO endpoint nobody configured is an open door.
  SSO_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32, 'An SSO secret needs at least 32 characters').optional(),
  ),
  // How long an SSO token may live. Five minutes: long enough to survive a slow
  // redirect, short enough that one read out of a proxy log is worth nothing.
  SSO_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(3600).default(300),

  // Attempts a minute per address at signing in: login, registration and both
  // SSO forms. Per address and not per account, because per account is how
  // somebody locks a person out of their own dashboard.
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),

  // Reads of a public share page a minute per address (AN-RPT01): the page
  // reads six routes on load and one per range change, so this is room for a
  // person and a wall for a script.
  SHARE_RATE_LIMIT: z.coerce.number().int().positive().default(120),

  // Whether the session cookie is Secure. Unset means "yes in production", which
  // is what anybody serving this over TLS wants; a developer on plain http has to
  // be able to sign in, which is the only reason this is settable at all.
  COOKIE_SECURE: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['true', 'false']).optional(),
    )
    .transform((value) => (value === undefined ? undefined : value === 'true')),
}).superRefine((parsed, context) => {
  if (parsed.REAL_IP_HEADER === 'x-chokh-forwarded-for' && parsed.CHOKH_PROXY_SECRET === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CHOKH_PROXY_SECRET'],
      message:
        'CHOKH_PROXY_SECRET is required for REAL_IP_HEADER=X-Chokh-Forwarded-For: without it the header is one anybody can set, so every visitor could claim any address',
    });
  }
  if (parsed.NODE_ENV === 'production' && parsed.SESSION_SECRET === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_SECRET'],
      message:
        'SESSION_SECRET is required in production: a generated one changes on every restart and signs everybody out',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

// The secret, or one made up for this process. Development only, by the refine
// above: a generated secret means every restart invalidates every session, which
// is fine on a laptop and is why the caller logs it.
export function resolveSessionSecret(): { secret: string; generated: boolean } {
  if (env.SESSION_SECRET !== undefined) {
    return { secret: env.SESSION_SECRET, generated: false };
  }
  return { secret: randomBytes(32).toString('base64url'), generated: true };
}

export function cookieSecure(): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

export function resolveDashboardDir(): string {
  if (env.DASHBOARD_DIR !== undefined) {
    return resolve(env.DASHBOARD_DIR);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../dashboard/dist');
}
