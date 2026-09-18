// Validated environment. Nothing else in the server reads process.env.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Where the built dashboard lives. Unset means "the sibling package's dist",
  // which is what a workspace checkout wants; the image sets it explicitly.
  DASHBOARD_DIR: z.string().min(1).optional(),
  // Read by the storage adapter (AN-STO01) and by presence (AN-SES01). Declared
  // here so the compose file and the deployment have one place to look.
  MONGODB_URI: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
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
