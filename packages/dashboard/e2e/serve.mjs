import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Starts a server, or uses the one already running.
//
// The screenshot script and the accessibility audit are both one command, and
// a script that needs a server started in another terminal first is a script
// somebody runs wrong once and then does not run again. Playwright starts its
// own through the config; these two start theirs here.
//
// Two servers, because the two jobs want different things. The audit wants the
// real one, since an accessibility score is only worth having over the markup a
// person is actually served. The screenshots want the frozen fixture, because a
// picture taken against live data changes every run and cannot be reviewed.

const HERE = dirname(fileURLToPath(import.meta.url));

async function answers(base) {
  try {
    // /health rather than /api/me: the real server answers that one without a
    // session, and both servers serve it.
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startFixture(port, which = 'fixture') {
  const file = which === 'real' ? 'server.mjs' : 'fixture-server.mjs';
  const base = `http://127.0.0.1:${port}`;
  if (await answers(base)) {
    // Somebody already has one up, which is what happens while the suite is
    // being written. Leave it alone, and leave it running afterwards.
    return { base, stop: () => undefined };
  }

  const child = spawn(process.execPath, [join(HERE, file)], {
    cwd: resolve(HERE, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await answers(base)) {
      return { base, stop: () => child.kill() };
    }
    await new Promise((wake) => setTimeout(wake, 250));
  }
  child.kill();
  throw new Error(
    `The fixture never answered on ${base}. Build the dashboard first: pnpm --filter @chokh/dashboard build`,
  );
}
