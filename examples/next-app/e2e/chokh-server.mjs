// The real Chokh server for the browser case: packages/server's buildApp on its
// memory store, serving the built tracker (a.js, v.js, e.js) as the image does,
// with the collector in the X-Chokh-Forwarded-For mode a first-party install
// runs. A second port answers what the store holds, for the case to read.
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CHOKH_PORT ?? 4115);
const peek = Number(process.env.CHOKH_PEEK_PORT ?? 4116);
const secret = process.env.CHOKH_PROXY_SECRET ?? 'chokh-e2e-proxy-secret-not-for-production';

// Read once, when the server's config module is first imported.
process.env.DASHBOARD_DIR = resolve(here, '..', '..', '..', 'packages', 'tracker', 'dist');
process.env.SESSION_SECRET ??= 'chokh-e2e-session-secret-not-for-production';
process.env.LOG_LEVEL ??= 'error';

const { buildApp } = await import('@chokh/server/app');
const { createMemoryStore } = await import('@chokh/server/store/memory');
const { defaultSiteSettings } = await import('@chokh/server/store');

const store = createMemoryStore([]);
await store.createSite({
  id: 's_next',
  name: 'Next example',
  domains: ['127.0.0.1'],
  teamId: 't_next',
  settings: defaultSiteSettings({ timezone: 'UTC', ipMode: 'full', visitorIdMode: 'persistent' }),
});

const app = await buildApp({
  store,
  ip: { trustProxy: [], realIpHeader: 'x-chokh-forwarded-for', proxySecret: secret },
});
await app.listen({ port, host: '127.0.0.1' });

let seenBefore = 0;
createServer((req, res) => {
  if (req.url === '/reset') {
    seenBefore = store.stored().length;
    res.writeHead(204).end();
    return;
  }
  const rows = store.stored().slice(seenBefore).filter((row) => row.siteId === 's_next');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(rows));
}).listen(peek, '127.0.0.1');
