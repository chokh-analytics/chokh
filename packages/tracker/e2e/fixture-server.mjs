// Serves the fixture page and the built tracker, and stands in for the
// collector by recording every batch it is posted. AN-COL01 builds the real one.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const port = Number(process.env.PORT ?? 4111);

let collected = [];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function file(res, path, type) {
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

const server = createServer((req, res) => {
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
        // A body that is not JSON is a failure the test should see as a missing
        // batch, not as a crash here.
      }
      res.writeHead(202).end();
    });
    return;
  }

  if (url.pathname === '/__collected') {
    json(res, 200, collected);
    return;
  }

  if (url.pathname === '/__reset') {
    collected = [];
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/a.js' || url.pathname === '/v.js') {
    void file(res, join(dist, url.pathname.slice(1)), 'text/javascript');
    return;
  }

  void file(res, join(here, 'fixture.html'), 'text/html');
});

server.listen(port, '127.0.0.1', () => {
  console.warn(`fixture server on http://127.0.0.1:${port}`);
});
