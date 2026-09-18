// Validated environment. Nothing else in the server reads process.env.
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
  // Read by the storage adapter (AN-STO01) and by presence (AN-SES01). Declared
  // here so the compose file and the deployment have one place to look.
  MONGODB_URI: optional,
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
    .pipe(z.enum(['x-forwarded-for', 'cf-connecting-ip'])),

  // Where the geo database lives, and the MaxMind key that chooses
  // GeoLite2-City over the keyless DB-IP Lite fallback.
  GEOIP_DIR: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).default('./data/geo')),
  GEOIP_LICENSE_KEY: optional,

  // Batches a minute, per address and per site.
  COLLECT_RATE_LIMIT_IP: z.coerce.number().int().positive().default(600),
  COLLECT_RATE_LIMIT_SITE: z.coerce.number().int().positive().default(60000),
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

export function resolveDashboardDir(): string {
  if (env.DASHBOARD_DIR !== undefined) {
    return resolve(env.DASHBOARD_DIR);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../dashboard/dist');
}
