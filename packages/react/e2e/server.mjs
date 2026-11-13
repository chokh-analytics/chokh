// The browser case's server: the fixture app, bundled by esbuild in development
// mode (strict mode runs effects twice only there), the real a.js from the
// tracker's build, and a collect path that records every batch it is posted.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4113);
const tracker = join(here, '..', '..', 'tracker', 'dist', 'a.js');

const bundle = await build({
  entryPoints: [join(here, 'app.tsx')],
  bundle: true,
  write: false,
  format: 'esm',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'error',
});
const appJs = bundle.outputFiles[0].contents;
const trackerJs = await readFile(tracker).catch(() => {
  throw new Error(`build the tracker first: pnpm --filter @chokh/tracker build (${tracker})`);
});

const html = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Chokh React fixture</title></head>',
  '<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
].join('\n');

let collected = [];

function send(res, type, body) {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/collect') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        collected.push(JSON.parse(body));
      } catch {
        // Not JSON: the case sees a missing batch, which is the failure.
      }
      res.writeHead(202).end();
    });
    return;
  }
  if (url.pathname === '/__collected') {
    send(res, 'application/json', JSON.stringify(collected));
    return;
  }
  if (url.pathname === '/__reset') {
    collected = [];
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/a.js') {
    send(res, 'application/javascript', trackerJs);
    return;
  }
  if (url.pathname === '/app.js') {
    send(res, 'application/javascript', appJs);
    return;
  }
  send(res, 'text/html; charset=utf-8', html);
}).listen(port, '127.0.0.1');
