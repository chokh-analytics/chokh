// Builds the dashboard's demo (packages/dashboard/vite.demo.config.ts) for
// the address the docs are served from, so its links and files sit under
// <base>demo/. Run before the site's build, which carries it.
//
//   pnpm --filter @chokh/docs site:demo
import { spawnSync } from 'node:child_process';

import { site } from '../site.config.mjs';

const result = spawnSync('pnpm', ['--filter', '@chokh/dashboard', 'build:demo'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DEMO_BASE: `${site.base}demo/` },
});
process.exit(result.status ?? 1);
