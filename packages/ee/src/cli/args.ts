// The smallest argument reader that does the job, because the job is small.
//
// Four commands and a dozen flags do not need a dependency, and this package is
// the one place in the repository where a dependency would also be a supply
// chain in front of the thing that mints licences.

export interface Args {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    index += 1;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const equals = name.indexOf('=');
    if (equals !== -1) {
      flags.set(name.slice(0, equals), name.slice(equals + 1));
      continue;
    }
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    index += 1;
  }
  return { command: positional.shift(), positional, flags };
}

export function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function has(args: Args, name: string): boolean {
  return args.flags.has(name);
}

// A flag with no value, or a missing one, is a mistake worth stopping on rather
// than a default worth guessing. Everything this CLI does is either signing
// something or reading something signed.
export function required(args: Args, name: string): string {
  const value = flag(args, name);
  if (value === undefined || value === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

export function optionalCount(args: Args, name: string): number | null {
  const value = flag(args, name);
  if (value === undefined) {
    return null;
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`--${name} has to be a whole number above zero`);
  }
  return count;
}

// Either a date, meaning midnight UTC on it, or a number of days from now.
// Midnight rather than the end of the day, so "expires 2027-09-20" and the line
// the dashboard prints agree about which day is the last one.
export function expirySeconds(args: Args, now: number): number {
  const days = flag(args, 'days');
  if (days !== undefined) {
    const count = Number(days);
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('--days has to be a whole number of days above zero');
    }
    return Math.floor(now / 1000) + count * 86_400;
  }
  const date = required(args, 'expires');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('--expires has to be a date like 2027-09-20, or use --days');
  }
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at)) {
    throw new Error(`--expires is not a date: ${date}`);
  }
  if (at <= now) {
    throw new Error(`--expires is in the past: ${date}`);
  }
  return Math.floor(at / 1000);
}
