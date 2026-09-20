import { z } from 'zod';

// The only place in the repository that reads CHOKH_LICENSE_KEY.
//
// It is here and not in packages/server/src/config/env.ts because the core
// never reads the licence key (ADR-0073 decision 4): a declaration there would
// be the crossing the rule exists to stop, and review refuses one from this
// ticket on. The repository rule that the core has exactly one environment
// reader still holds; this package has its own, validated the same way, which
// is what AGENTS.md now says.
//
// Empty is treated as unset. A compose file or a deploy script that writes
// CHOKH_LICENSE_KEY= with nothing after it means "no key", and reading that as
// a malformed key would tell an honest operator they had done something wrong.

const schema = z.object({
  CHOKH_LICENSE_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
});

export function readLicenseKey(source: NodeJS.ProcessEnv = process.env): string | undefined {
  return schema.parse({ CHOKH_LICENSE_KEY: source['CHOKH_LICENSE_KEY'] }).CHOKH_LICENSE_KEY;
}
