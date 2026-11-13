// What npm would get, checked before anybody publishes it.
//
// For each of the three packages: `pnpm pack` (which applies publishConfig and
// turns workspace: ranges into versions), then the tarball's file list and its
// package.json. Then a throwaway consumer installs the three tarballs with their
// peers from the registry and proves, from the outside, that the types resolve
// and the code loads: tsc as an ES module and as CommonJS under node16, under
// bundler resolution, and under the old node10 resolution (typesVersions), and
// node importing and requiring each entry a plain Node process can load.
//
// The consumer lives in .pack-check/ at the repository root (ignored by git),
// not in the system temp directory, and is deleted at the end unless
// --keep is passed.
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The report goes to stdout; lint keeps console for warnings and errors.
const say = (line) => process.stdout.write(`${line}\n`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, '.pack-check');
const tarballs = join(work, 'tarballs');
const consumer = join(work, 'consumer');
const keep = process.argv.includes('--keep');
// pnpm and npm are .cmd shims on Windows, which only a shell runs; node is
// run directly, its path having a space in it there.
const shims = new Set(['pnpm', 'npm']);

const PACKAGES = [
  { dir: 'packages/sdk-node', name: '@chokh/sdk-node', entries: ['.'] },
  { dir: 'packages/react', name: '@chokh/react', entries: ['.'] },
  { dir: 'packages/next', name: '@chokh/next', entries: ['.', './config', './collect'] },
];

const problems = [];
const fail = (message) => problems.push(message);

function run(command, args, cwd) {
  const shell = process.platform === 'win32' && shims.has(command);
  return execFileSync(command, args, { cwd, encoding: 'utf8', shell, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A .tgz read here rather than by tar, which on Windows takes a drive letter
// for a host name: gunzip, then 512-byte headers, each followed by its file.
function readTarball(file) {
  const bytes = gunzipSync(readFileSync(file));
  const field = (header, from, to) => header.subarray(from, to).toString('utf8').split('\u0000')[0] ?? '';
  const entries = new Map();
  for (let at = 0; at + 512 <= bytes.length; ) {
    const header = bytes.subarray(at, at + 512);
    const name = field(header, 0, 100);
    if (name === '') break;
    const prefix = field(header, 345, 500);
    const size = parseInt(field(header, 124, 136).trim() || '0', 8);
    const type = field(header, 156, 157) || '0';
    if (type === '0') {
      const path = (prefix === '' ? name : prefix + '/' + name).replace(/^package\//, '');
      entries.set(path, bytes.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

rmSync(work, { recursive: true, force: true });
mkdirSync(tarballs, { recursive: true });

const packed = [];
for (const pkg of PACKAGES) {
  run('pnpm', ['pack', '--pack-destination', tarballs], join(root, pkg.dir));
  const version = JSON.parse(readFileSync(join(root, pkg.dir, 'package.json'), 'utf8')).version;
  const file = join(tarballs, `${pkg.name.replace('@', '').replace('/', '-')}-${version}.tgz`);
  packed.push(file);

  const entries = readTarball(file);
  const files = [...entries.keys()];
  for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/esm/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.js', 'dist/cjs/index.d.ts', 'dist/cjs/package.json']) {
    if (!files.includes(required)) fail(`${pkg.name}: the tarball has no ${required}`);
  }
  for (const name of files) {
    if (name.startsWith('src/') || /\.test\./.test(name) || name.endsWith('.map') || name.includes('e2e/') || name.endsWith('tsconfig.json')) {
      fail(`${pkg.name}: the tarball carries ${name}`);
    }
  }

  const text = entries.get('package.json')?.toString('utf8') ?? '{}';
  const manifest = JSON.parse(text);
  if (text.includes('workspace:')) fail(`${pkg.name}: a workspace: range is left in the packed package.json`);
  if (manifest.private === true) fail(`${pkg.name}: the packed package.json is private`);
  if (manifest.license !== 'MIT') fail(`${pkg.name}: the licence is ${manifest.license}, not MIT`);
  for (const entry of pkg.entries) {
    const conditions = manifest.exports?.[entry];
    for (const condition of ['import', 'require']) {
      const target = conditions?.[condition];
      if (target === undefined || Object.keys(target)[0] !== 'types' || !String(target.default).startsWith('./dist/')) {
        fail(`${pkg.name}: exports["${entry}"].${condition} is not { types, default } into dist`);
      } else if (!files.includes(target.types.slice(2)) || !files.includes(target.default.slice(2))) {
        fail(`${pkg.name}: exports["${entry}"].${condition} names a file the tarball does not carry`);
      }
    }
  }
  say(`${pkg.name}: ${files.length} files, exports ${pkg.entries.join(' ')}`);
}

// The consumer: the three tarballs, and the peers a real app would have.
mkdirSync(consumer, { recursive: true });
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'chokh-pack-consumer', private: true, version: '0.0.0' }, null, 2));
run(
  'npm',
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    ...packed,
    'react@19',
    'react-dom@19',
    'next@16',
    'typescript@5',
    '@types/react@19',
    '@types/node@22',
  ],
  consumer,
);

const use = `
import { createClient, signUserId, type ChokhDrop } from '@chokh/sdk-node';
import { ChokhProvider, useTrack, track, type ChokhProps } from '@chokh/react';
import { Analytics, useConsent } from '@chokh/next';
import { withChokh, chokhRewrites } from '@chokh/next/config';
import { createCollectRoute } from '@chokh/next/collect';

const client = createClient({ url: 'https://analytics.example.com', siteId: 's', apiKey: 'k', onDrop: (drop: ChokhDrop) => void drop.reason });
client.track('u', 'paid', { value: 1, props: { plan: 'pro' } });
const signature: string = signUserId('secret', 's', 'u');
const props: ChokhProps = { plan: 'pro' };
track('signup', props);
const config = withChokh({ reactStrictMode: true }, { url: 'https://analytics.example.com' });
const rewrites: { source: string; destination: string }[] = chokhRewrites({ url: 'x' });
const POST: (request: Request) => Promise<Response> = createCollectRoute({ url: 'https://analytics.example.com' });
export { ChokhProvider, useTrack, Analytics, useConsent, config, rewrites, POST, signature };
`;
writeFileSync(join(consumer, 'esm.mts'), use);
writeFileSync(join(consumer, 'cjs.cts'), use);
writeFileSync(join(consumer, 'bundler.ts'), use);
const base = { strict: true, noEmit: true, skipLibCheck: true, jsx: 'react-jsx', types: ['node'], lib: ['ES2023', 'DOM'] };
const configs = {
  'node16 (ES module and CommonJS)': { compilerOptions: { ...base, module: 'node16', moduleResolution: 'node16' }, files: ['esm.mts', 'cjs.cts'] },
  bundler: { compilerOptions: { ...base, module: 'esnext', moduleResolution: 'bundler' }, files: ['bundler.ts'] },
  'node10 (typesVersions)': { compilerOptions: { ...base, module: 'commonjs', moduleResolution: 'node10' }, files: ['bundler.ts'] },
};
for (const [label, config] of Object.entries(configs)) {
  const file = `tsconfig.${label.split(' ')[0]}.json`;
  writeFileSync(join(consumer, file), JSON.stringify(config, null, 2));
  try {
    run(process.execPath, [join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', file], consumer);
    say(`types resolve under ${label}`);
  } catch (error) {
    fail(`types under ${label}:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

// What plain Node loads. '@chokh/next' itself is for a bundler (it imports
// next/script, which Next resolves and Node's ES module loader does not), so
// as an ES module only its two Node entries are loaded; required, all three.
const esm = `
const sdk = await import('@chokh/sdk-node');
const react = await import('@chokh/react');
const config = await import('@chokh/next/config');
const collect = await import('@chokh/next/collect');
if (sdk.signUserId('chokh-identify-test-vector-secret', 'ps_web', 'u_42') !== 'PZKnTzQ2RNvGrAh-ROhA2pmOsHB0CiwrBXfINflfMms') throw new Error('identify vector');
if (await collect.signForwardedAddress('chokh-forwarded-test-vector-secret', '103.87.12.45', 1758268800000) !== 'vxccd7YCjDD2KrAqUmGDrfSTHL5jlRlHITsOsLZqlho') throw new Error('forwarded vector');
for (const [name, value] of [['createClient', sdk.createClient], ['ChokhProvider', react.ChokhProvider], ['withChokh', config.withChokh], ['createCollectRoute', collect.createCollectRoute]]) {
  if (typeof value !== 'function') throw new Error(name + ' did not load');
}
say('ES modules load: @chokh/sdk-node, @chokh/react, @chokh/next/config, @chokh/next/collect');
`;
const cjs = `
const sdk = require('@chokh/sdk-node');
const react = require('@chokh/react');
const next = require('@chokh/next');
const config = require('@chokh/next/config');
const collect = require('@chokh/next/collect');
if (sdk.signUserId('chokh-identify-test-vector-secret', 'ps_web', 'u_42') !== 'PZKnTzQ2RNvGrAh-ROhA2pmOsHB0CiwrBXfINflfMms') throw new Error('identify vector');
for (const [name, value] of [['createClient', sdk.createClient], ['useTrack', react.useTrack], ['Analytics', next.Analytics], ['withChokh', config.withChokh], ['createCollectRoute', collect.createCollectRoute]]) {
  if (typeof value !== 'function') throw new Error(name + ' did not load');
}
say('CommonJS loads: @chokh/sdk-node, @chokh/react, @chokh/next, @chokh/next/config, @chokh/next/collect');
`;
writeFileSync(join(consumer, 'load.mjs'), esm);
writeFileSync(join(consumer, 'load.cjs'), cjs);
for (const file of ['load.mjs', 'load.cjs']) {
  try {
    process.stdout.write(run(process.execPath, [file], consumer));
  } catch (error) {
    fail(`node ${file}:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

if (!keep) rmSync(work, { recursive: true, force: true });
if (problems.length > 0) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((line) => `- ${line}`).join('\n')}`);
  process.exit(1);
}
say('pack check: every tarball is what npm should get');
