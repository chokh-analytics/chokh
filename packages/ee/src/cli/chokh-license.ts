#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ALL_FEATURES, type LicensePayload } from '../license/payload.js';
import { PUBLIC_KEYS } from '../license/public-key.js';
import { publicKeyToBase64, signLicense } from '../license/token.js';
import { verifyLicense } from '../license/verify.js';
import { expirySeconds, flag, has, optionalCount, parseArgs, required, type Args } from './args.js';

// chokh-license: keygen, mint, show, verify.
//
// The founder runs keygen once, on their own machine, and keeps the private key
// the way they keep any other secret. Nothing else in this repository ever
// holds one: not the server, not a test, not CI, not an image. A process that
// can sign a licence is a process that does not need one.
//
// keygen therefore writes the private key to a file with owner-only
// permissions and prints only the public half. A secret that goes to stdout is
// a secret in a shell history, a terminal scrollback and whatever is recording
// the session, and this one cannot be rotated quietly once it is out: every key
// ever minted with it is signed by it.

const HELP = `chokh-license

  keygen  --out <dir>
      Make an Ed25519 pair. The private key is written to <dir>/chokh-license.key
      with owner-only permissions and is never printed. The public line is
      printed, to be pasted into packages/ee/src/license/public-key.ts.

  mint    --key <file> --licensee <name> (--expires <YYYY-MM-DD> | --days <n>)
          [--plan <name>] [--features <a,b|*>] [--seats <n>] [--sites <n>]
          [--id <id>]
      Sign a licence key and print it.

  show    <key>
      Print what a key says, without checking who signed it.

  verify  <key> [--public-key <base64>]
      Check a key against this build's public keys, or against one given here.

Examples:
  chokh-license keygen --out ~/.chokh
  chokh-license mint --key ~/.chokh/chokh-license.key \\
    --licensee "Progsity, BWJ Tech Ltd." --features "*" --expires 2028-09-20
  chokh-license verify "$CHOKH_LICENSE_KEY"
`;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function keygen(args: Args): void {
  const dir = resolve(required(args, 'out'));
  const file = join(dir, 'chokh-license.key');
  if (existsSync(file) && !has(args, 'force')) {
    die(
      `${file} already exists. Every key ever minted with it is signed by it, so this will not overwrite one without --force.`,
    );
  }
  mkdirSync(dir, { recursive: true });

  const generated = generateKeyPairSync('ed25519');
  const privateKey = generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKey = publicKeyToBase64(
    generated.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  );

  writeFileSync(file, privateKey, { encoding: 'utf8', mode: 0o600 });
  // Written again explicitly, because the mode argument above is ignored when
  // the file already existed and is a no-op on some filesystems.
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no mode to set. The file is in the founder's own profile.
  }

  out(`Private key written to ${file}. It is not printed, here or anywhere.`);
  out('Keep it in your password manager. It cannot be recovered, and it cannot');
  out('be rotated quietly: every key ever minted with it is signed by it.');
  out('');
  out('Public key, to paste into packages/ee/src/license/public-key.ts:');
  out('');
  out(`  '${publicKey}',`);
}

function mint(args: Args, now: number): void {
  const keyFile = resolve(required(args, 'key'));
  let privateKey: string;
  try {
    privateKey = readFileSync(keyFile, 'utf8');
  } catch {
    return die(`No private key at ${keyFile}. Run keygen first, or pass --key.`);
  }

  const features = (flag(args, 'features') ?? ALL_FEATURES)
    .split(',')
    .map((feature) => feature.trim())
    .filter((feature) => feature !== '');
  if (features.length === 0) {
    return die('--features cannot be empty. Use "*" for every feature.');
  }

  const payload: LicensePayload = {
    v: 1,
    id: flag(args, 'id') ?? `lic_${randomBytes(6).toString('hex')}`,
    licensee: required(args, 'licensee'),
    plan: flag(args, 'plan') ?? 'pro',
    features,
    seats: optionalCount(args, 'seats'),
    sites: optionalCount(args, 'sites'),
    issuedAt: Math.floor(now / 1000),
    expiresAt: expirySeconds(args, now),
  };

  out(signLicense(privateKey, payload));
}

function show(args: Args): void {
  const raw = args.positional[0];
  if (raw === undefined) {
    return die('show needs a key');
  }
  const segment = raw.replace(/^CHOKH-/, '').split('.')[0];
  if (segment === undefined || segment === '') {
    return die('That is not a Chokh licence key.');
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    out(JSON.stringify(decoded, null, 2));
    // Said every time, because this command exists for support: somebody pasted
    // a key into an email and wants to know what it claims. What it claims and
    // what it is are different questions, and verify answers the other one.
    process.stderr.write('This is what the key says. Nobody checked who signed it. Use verify.\n');
  } catch {
    die('That key does not decode.');
  }
}

function verify(args: Args, now: number): void {
  const raw = args.positional[0];
  if (raw === undefined) {
    return die('verify needs a key');
  }
  const given = flag(args, 'public-key');
  const publicKeys = given === undefined ? PUBLIC_KEYS : [given];
  if (publicKeys.length === 0) {
    return die(
      'This build carries no public key, so it believes nobody. Pass --public-key, or add yours to packages/ee/src/license/public-key.ts.',
    );
  }

  const result = verifyLicense(raw, { now, publicKeys });
  if (!result.ok) {
    return die(`Refused: ${result.reason}`);
  }
  const license = result.license;
  out('Valid.');
  out(`  id        ${license.id}`);
  out(`  licensee  ${license.licensee}`);
  out(`  plan      ${license.plan}`);
  out(`  features  ${license.features.join(', ')}`);
  out(`  seats     ${license.seats ?? 'unlimited'}`);
  out(`  sites     ${license.sites ?? 'unlimited'}`);
  out(`  issued    ${new Date(license.issuedAt * 1000).toISOString()}`);
  out(`  expires   ${new Date(license.expiresAt * 1000).toISOString()}`);
}

export function run(argv: readonly string[], now: number = Date.now()): void {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case 'keygen':
        return keygen(args);
      case 'mint':
        return mint(args, now);
      case 'show':
        return show(args);
      case 'verify':
        return verify(args, now);
      case undefined:
      case 'help':
        return out(HELP);
      default:
        return die(`Unknown command: ${args.command}\n\n${HELP}`);
    }
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

// Only when this file is the program, compared exactly rather than by name, so
// a test file whose own name contains "chokh-license" does not start the CLI
// and exit the test runner.
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  run(process.argv.slice(2));
}
