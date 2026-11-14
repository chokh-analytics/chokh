// Serves dist/ under the base path, the way GitHub Pages will: a folder is
// its index.html, and anything that is not a file is 404.html with a 404.
// For looking at the site and for the audit; not a production server.
//
//   PORT=4120 node scripts/serve.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { site } from '../site.config.mjs';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 4120);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

async function file(path) {
  try {
    const found = await stat(path);
    return found.isDirectory() ? file(join(path, 'index.html')) : path;
  } catch {
    return null;
  }
}

export function startServer(at = port) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/' && site.base !== '/') {
      response.writeHead(302, { location: site.base });
      response.end();
      return;
    }
    let found = null;
    if (url.pathname.startsWith(site.base)) {
      const inside = normalize(decodeURIComponent(url.pathname.slice(site.base.length)));
      const target = join(DIST, inside);
      // Nothing outside dist/, whatever the path says.
      if (target.startsWith(DIST)) {
        found = await file(target);
      }
    }
    if (found === null) {
      response.writeHead(404, { 'content-type': TYPES['.html'] });
      response.end(await readFile(join(DIST, '404.html')));
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(found)] ?? 'application/octet-stream' });
    response.end(await readFile(found));
  });
  return new Promise((done) => {
    server.listen(at, '127.0.0.1', () => done(server));
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
  process.stdout.write(`docs: http://127.0.0.1:${port}${site.base}\n`);
}
