// Serves the built dashboard from the same process as the collector, so one
// image is a complete install. When the dashboard has not been built the server
// still starts and the API still answers.
import { existsSync } from 'node:fs';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import { resolveDashboardDir } from '../config/env.js';

export async function registerDashboard(
  app: FastifyInstance,
  // Test seam, the way MemoryStore.clear is one. The environment is read once
  // at boot, so a test that wants a directory of its own cannot get there
  // through process.env.
  override?: string,
): Promise<string | null> {
  const root = override ?? resolveDashboardDir();
  if (!existsSync(root)) {
    app.log.warn({ root }, 'dashboard build not found, static hosting is off');
    return null;
  }

  await app.register(fastifyStatic, {
    root,
    index: ['index.html'],
    // Off, so setHeaders below is the only thing that decides. Left on, the
    // plugin writes its own max-age after setHeaders has run and the rule
    // underneath would be invisible.
    cacheControl: false,
    setHeaders(response, path) {
      // Vite writes every asset with a hash of its contents in the name, so a
      // file under assets/ can never change without changing its name and can
      // be kept for as long as a browser likes. index.html is the opposite: it
      // is the one file whose name is fixed and whose contents name the hashed
      // ones.
      //
      // This is not a nicety. Without it a deploy leaves every returning
      // visitor holding a cached index.html asking for asset names the new
      // build no longer has, and the dashboard is a blank page until somebody
      // reloads by hand. Nothing in development ever redeploys, so this is a
      // failure that only exists in production and only after a second deploy.
      //
      // The test is the directory name rather than a path separator, because
      // this is a filesystem path and the separator is not the same on every
      // machine this image is built on. Vite puts every hashed file in assets
      // and nothing else in the build has that word in it.
      const hashed = path.includes('assets');
      response.setHeader(
        'cache-control',
        hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });

  return root;
}
