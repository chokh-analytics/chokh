import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TestProject } from 'vitest/node';

import { readEnv } from '../env.js';

// Where the package's tests find a PostgreSQL.
//
// CI hands one over in CHOKH_TEST_DATABASE_URL (a service container, the image
// people deploy). Without it, one is started here from the binaries the
// embedded-postgres package brought with `pnpm install`, in a temporary
// directory on a free port, and stopped and deleted when the run ends. Nothing
// is downloaded at test time, nothing is installed as a service and nothing is
// left running.

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

// What initdb says when the checkout sits so deep that its own files pass
// Windows' 260 character path limit. It names an extension, which sends
// anybody reading it the wrong way.
const PATH_TOO_LONG = /extension "plpgsql" is not available/;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const provided = readEnv().CHOKH_TEST_DATABASE_URL;
  if (provided !== undefined) {
    project.provide('databaseUrl', provided);
    return async () => undefined;
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const directory = mkdtempSync(join(tmpdir(), 'chokh-pg-'));
  const port = await freePort();
  const log: string[] = [];
  const server = new EmbeddedPostgres({
    databaseDir: directory,
    user: 'chokh',
    password: 'chokh',
    port,
    persistent: false,
    // Without these a Windows machine creates the database in its own code
    // page, and the first Bangla title a test writes is refused.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: (line: unknown) => log.push(String(line)),
    onError: (line: unknown) => log.push(String(line)),
  });
  try {
    await server.initialise();
    await server.start();
  } catch (error) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    const said = `${error instanceof Error ? error.message : String(error)}\n${log.join('\n')}`;
    if (PATH_TOO_LONG.test(said)) {
      throw new Error(
        'The bundled PostgreSQL could not initialise: this checkout is deep enough that its files pass the 260 character path limit of Windows. Move the checkout to a shorter path, or point CHOKH_TEST_DATABASE_URL at a PostgreSQL 15 or newer.',
      );
    }
    throw new Error(
      `The bundled PostgreSQL could not start. Point CHOKH_TEST_DATABASE_URL at a PostgreSQL 15 or newer to use that instead.\n${said}`,
    );
  }
  project.provide('databaseUrl', `postgresql://chokh:chokh@127.0.0.1:${port}/postgres`);

  return async () => {
    await server.stop();
    // On Windows the directory stays locked for a moment after the last server
    // process has gone, so the removal waits for it rather than failing a run
    // whose tests all passed.
    rmSync(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  };
}
