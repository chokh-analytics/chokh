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

import {
  AGGREGATE,
  ENGAGEMENT,
  ME,
  PROFILE,
  REALTIME,
  breakdown,
  timeseries,
} from './fixture-data.mjs';

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

function send(res, status, body, meta) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(meta === undefined ? body : { ...body, meta }));
}

function ok(res, data, meta) {
  send(res, 200, { success: true, data }, meta);
}

function refuse(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: { code, message } }));
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

function api(url, res) {
  const path = url.pathname;
  const params = url.searchParams;

  if (path === '/api/me') {
    return ok(res, ME);
  }
  if (path.endsWith('/stats/aggregate')) {
    return ok(res, AGGREGATE);
  }
  if (path.endsWith('/stats/timeseries')) {
    return ok(res, timeseries(params.get('interval') ?? 'day'));
  }
  if (path.endsWith('/stats/breakdown')) {
    return ok(res, breakdown(params.get('dim') ?? 'page', Number(params.get('limit') ?? 10)));
  }
  if (path.endsWith('/stats/engagement')) {
    return ok(res, ENGAGEMENT, { retentionDays: 180 });
  }
  if (path.endsWith('/realtime')) {
    // No identity, which is the default an install has: the address column is
    // absent and the page says which permission would show it.
    return ok(res, REALTIME, { identity: false });
  }
  if (path.includes('/visitors/')) {
    return ok(res, PROFILE, { identity: false });
  }
  if (path.includes('/users/')) {
    return refuse(
      res,
      403,
      'FORBIDDEN',
      'This lookup names a person, so it needs the read:identity permission.',
    );
  }
  return refuse(res, 404, 'NOT_FOUND', `Nothing answers ${path}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Both servers answer this, so one helper can wait for either.
  if (url.pathname === '/health') {
    return ok(res, { status: 'ok' });
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
      res.write(`data: ${JSON.stringify({ success: true, data: REALTIME })}

`);
      return undefined;
    }
    return api(url, res);
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
