import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publicKeyToBase64 } from '../license/token.js';
import { verifyLicense } from '../license/verify.js';
import { run } from './chokh-license.js';

// The CLI, driven in process with its three streams captured.
//
// Every pair made here is a throwaway in a temp directory that is deleted after
// the case. The product's own private key is made once by the founder on their
// own machine and exists nowhere else, which is the rule this file is careful
// not to be the first exception to.

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

let dir: string;
let stdout: string[];
let stderr: string[];
let exited: number | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chokh-cli-'));
  stdout = [];
  stderr = [];
  exited = null;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited = code ?? 0;
    // die() is typed as never and every caller returns straight after it, so
    // stopping here is what the real process.exit does to the rest of the run.
    throw new Error('exit');
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function call(...argv: string[]): void {
  try {
    run(argv, NOW);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'exit') {
      throw error;
    }
  }
}

function printed(): string {
  return stdout.join('');
}

function keyFile(): string {
  return join(dir, 'chokh-license.key');
}

function publicKeyOf(): string {
  return publicKeyToBase64(readFileSync(keyFile(), 'utf8'));
}

describe('keygen', () => {
  it('writes the private key to a file and never prints it', () => {
    call('keygen', '--out', dir);

    const privateKey = readFileSync(keyFile(), 'utf8');
    expect(privateKey).toContain('BEGIN PRIVATE KEY');
    // The whole of ruling 2 in one assertion: a secret on stdout is a secret in
    // a shell history, a scrollback and whatever is recording the session.
    expect(printed()).not.toContain('PRIVATE KEY');
    for (const line of privateKey.split('\n')) {
      if (line.trim().length > 20) {
        expect(printed()).not.toContain(line.trim());
      }
    }
  });

  it('prints the public line to paste into the build', () => {
    call('keygen', '--out', dir);

    expect(printed()).toContain('public-key.ts');
    expect(printed()).toContain(`  '${publicKeyOf()}',`);
  });

  // A signing pair cannot be replaced quietly: every key ever minted with it is
  // signed by it, so overwriting one by accident invalidates everything sold.
  it('refuses to overwrite a pair that is already there', () => {
    call('keygen', '--out', dir);
    const first = readFileSync(keyFile(), 'utf8');
    stdout = [];

    call('keygen', '--out', dir);

    expect(exited).toBe(1);
    expect(stderr.join('')).toContain('already exists');
    expect(readFileSync(keyFile(), 'utf8')).toBe(first);
  });
});

describe('mint', () => {
  beforeEach(() => {
    call('keygen', '--out', dir);
    stdout = [];
  });

  it('signs a key the verifier accepts', () => {
    call(
      'mint',
      '--key',
      keyFile(),
      '--licensee',
      'A Test Company Ltd.',
      '--features',
      '*',
      '--expires',
      '2028-09-20',
    );

    const key = printed().trim();
    expect(key.startsWith('CHOKH-')).toBe(true);
    const result = verifyLicense(key, { now: NOW, publicKeys: [publicKeyOf()] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.license.licensee).toBe('A Test Company Ltd.');
    // The founder's decision, carried by every key the first plan issues.
    expect(result.ok && result.license.plan).toBe('pro');
    expect(result.ok && result.license.seats).toBeNull();
    expect(result.ok && result.license.sites).toBeNull();
    expect(result.ok && result.license.expiresAt).toBe(Date.parse('2028-09-20T00:00:00Z') / 1000);
  });

  // The trial is not a feature, it is a short key. Thirty days, minted by hand,
  // and nothing else in the product knows the difference.
  it('mints a trial as a key with a plan and a number of days', () => {
    call(
      'mint',
      '--key',
      keyFile(),
      '--licensee',
      'Somebody Trying It',
      '--plan',
      'trial',
      '--days',
      '30',
    );

    const result = verifyLicense(printed().trim(), { now: NOW, publicKeys: [publicKeyOf()] });
    expect(result.ok && result.license.plan).toBe('trial');
    expect(result.ok && result.license.expiresAt).toBe(Math.floor(NOW / 1000) + 30 * 86_400);
    expect(verifyLicense(printed().trim(), {
      now: NOW + 31 * 86_400_000,
      publicKeys: [publicKeyOf()],
    })).toEqual({ ok: false, reason: 'expired' });
  });

  it('names the features it was given, and nothing else', () => {
    call(
      'mint',
      '--key',
      keyFile(),
      '--licensee',
      'A Test Company Ltd.',
      '--features',
      'alerts, digests',
      '--days',
      '10',
    );

    const result = verifyLicense(printed().trim(), { now: NOW, publicKeys: [publicKeyOf()] });
    expect(result.ok && result.license.features).toEqual(['alerts', 'digests']);
  });

  it.each([
    ['a date in the past', ['--expires', '2020-01-01']],
    ['a date that is not one', ['--expires', 'next tuesday']],
    ['no expiry at all', []],
    ['seats that are not a number', ['--days', '10', '--seats', 'lots']],
  ])('refuses %s', (_name, extra) => {
    call('mint', '--key', keyFile(), '--licensee', 'A Test Company Ltd.', ...extra);

    expect(exited).toBe(1);
    expect(printed()).toBe('');
  });

  it('says where to look when there is no private key', () => {
    call('mint', '--key', join(dir, 'nothing-here.key'), '--licensee', 'X', '--days', '1');

    expect(exited).toBe(1);
    expect(stderr.join('')).toContain('keygen');
  });
});

describe('show and verify', () => {
  let key: string;

  beforeEach(() => {
    call('keygen', '--out', dir);
    stdout = [];
    call('mint', '--key', keyFile(), '--licensee', 'A Test Company Ltd.', '--days', '90');
    key = printed().trim();
    stdout = [];
    stderr = [];
  });

  it('shows what a key claims, and says that is all it did', () => {
    call('show', key);

    expect(JSON.parse(printed())).toMatchObject({ licensee: 'A Test Company Ltd.', plan: 'pro' });
    expect(stderr.join('')).toContain('Nobody checked who signed it');
  });

  it('verifies a key against a public key it is given', () => {
    call('verify', key, '--public-key', publicKeyOf());

    expect(printed()).toContain('Valid.');
    expect(printed()).toContain('A Test Company Ltd.');
    expect(printed()).toContain('unlimited');
    expect(exited).toBeNull();
  });

  it('refuses a key signed by somebody else, and says why', () => {
    const other = mkdtempSync(join(tmpdir(), 'chokh-cli-other-'));
    call('keygen', '--out', other);
    const stranger = publicKeyToBase64(readFileSync(join(other, 'chokh-license.key'), 'utf8'));
    stdout = [];

    call('verify', key, '--public-key', stranger);

    expect(exited).toBe(1);
    expect(stderr.join('')).toContain('bad_signature');
    rmSync(other, { recursive: true, force: true });
  });

  // The state of this build: no public key in the source, so it believes
  // nobody, and it says that rather than reporting a bad signature.
  it('says this build has no issuer when no public key is given', () => {
    call('verify', key);

    expect(exited).toBe(1);
    expect(stderr.join('')).toContain('believes nobody');
  });
});

describe('the program itself', () => {
  it('prints help when it is asked for nothing', () => {
    call();
    expect(printed()).toContain('chokh-license');
    expect(printed()).toContain('keygen');
  });

  it('refuses a command it does not have', () => {
    call('revoke');
    expect(exited).toBe(1);
    expect(stderr.join('')).toContain('Unknown command');
  });
});
