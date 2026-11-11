import { z } from 'zod';

// The only reader of the environment in this package. The adapter itself reads
// nothing: whoever opens it hands it a connection string. What is read here is
// for the two things that run on their own, the migrate command and the tests.
const optional = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'A PostgreSQL URL starts with postgres:// or postgresql://')
    .optional(),
);

const envSchema = z.object({
  // Where `migrate` connects when no --url is given: the same variable the
  // server reads, so one environment serves both.
  DATABASE_URL: optional,
  // A PostgreSQL the tests should use instead of starting their own. CI sets
  // it to its service container; a contributor sets it when the bundled
  // binaries cannot run where their checkout lives.
  CHOKH_TEST_DATABASE_URL: optional,
});

export type PostgresEnv = z.infer<typeof envSchema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): PostgresEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
