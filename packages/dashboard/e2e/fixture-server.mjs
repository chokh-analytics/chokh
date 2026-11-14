// Serves the built dashboard and stands in for the collector's API.
//
// The real server serves these files itself from the same origin, which is why
// nothing here proxies: the fixture is the same arrangement, a static tree plus
// /api, so a path that only works through a dev proxy fails here the way it
// would fail in production.
//
// Every answer is the contract's envelope. A fixture that invents a shape
// proves the dashboard against a server that does not exist.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { answer, REALTIME_FRAME } from './fixture-answers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const port = Number(process.env.PORT ?? 4113);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function send(res, { status, body }) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function serveFile(res, path) {
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// What fixture-answers.mjs says, unlicensed, as an install with no key is.
// Whoever opens an invitation link is nobody yet: the page asking from
// /invite is told so, and draws the form somebody new would see.
function api(url, res, req) {
  const invite = new URL(req.headers.referer ?? 'http://x/').pathname === '/invite';
  return send(res, answer(url.pathname, url.searchParams, { invite }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Both servers answer this, so one helper can wait for either.
  if (url.pathname === '/health') {
    return send(res, answer('/health', url.searchParams));
  }

  if (url.pathname.startsWith('/api/')) {
    // One frame, then held open.
    //
    // A screenshot of Realtime has to show the page in the state it is in on a
    // working install, and a fixture that refuses the stream photographs the
    // reconnecting line instead. The browser suite drives the real server and
    // proves the failure paths there; this one exists to be photographed.
    if (url.pathname.endsWith('/realtime/stream')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(REALTIME_FRAME)}

`);
      return undefined;
    }
    return api(url, res, req);
  }

  const asked = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  void (async () => {
    if (asked !== '/' && (await serveFile(res, join(dist, asked)))) {
      return;
    }
    // Every other path is the application's own: it is a single page and the
    // router reads the URL, so /s_demo/geo has to answer index.html.
    if (!(await serveFile(res, join(dist, 'index.html')))) {
      res.writeHead(500).end('Build the dashboard first: pnpm --filter @chokh/dashboard build');
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.warn(`dashboard fixture on http://127.0.0.1:${port}`);
});
