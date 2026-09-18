// The load test the AN-API01 ticket asks for: POST /api/collect at 200 requests a
// second with a 95th percentile under 20 ms, on a laptop.
//
// It runs the real server, on a real port, with a real adapter. Two ways:
//
//   node scripts/load-collect.mjs            the in-memory adapter
//   node scripts/load-collect.mjs --mongo    a real mongod, downloaded by
//                                            mongodb-memory-server, so the number
//                                            includes the database writes
//
// Not in CI. A shared runner's p95 is noise, and a gate that fails for somebody
// else's noisy neighbour teaches people to ignore gates.
//
// What the number covers: the collector accepting a batch and answering 202, with
// the origin check, the geo lookup, the user agent parse, the bot heuristic, the
// dedupe, the session fold and the write to the store all inside the measurement. The
// percentile is computed from every response rather than read off autocannon's fixed
// list, which has a p90 and a p97.5 and no p95.
//
// How the load is shaped, and why, because two obvious shapings measure the wrong
// thing. All the traffic arrives from 127.0.0.1 with one user agent, so in cookieless
// mode the collector derives one visitor id for all of it and every batch lands on
// one session document: that is a write hotspot no real site has. And a repeated
// pageview is one pageview, so a constant path would be swallowed by the dedupe and
// the store would barely be touched. So: the site is in persistent mode, each
// connection carries its own visitor id, and the event is a custom event rather than
// a pageview, which the dedupe does not collapse. Every request therefore does a full
// read, fold and write.
//
// The body is set once per connection rather than per request on purpose.
// autocannon's setBody rebuilds a request on the hot path and costs about 30 ms a
// call on this machine, which would be measured as the server's latency and is not.

import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import autocannon from 'autocannon';

// mongodb and mongodb-memory-server belong to @chokh/store-mongo, not to the root,
// so they are resolved from that package rather than from here. A pnpm workspace does
// not hoist, and hoisting for the sake of a script would be the wrong fix.
const fromStoreMongo = createRequire(new URL('../packages/store-mongo/package.json', import.meta.url));

function importFromStoreMongo(specifier) {
  return import(pathToFileURL(fromStoreMongo.resolve(specifier)).href);
}

const REQUESTS_PER_SECOND = 200;
const SECONDS = 20;
const P95_BUDGET_MS = 20;
const CONNECTIONS = 20;
const SITE_ID = 'load_test';
const HOSTNAME = 'load.test';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const useMongo = process.argv.includes('--mongo');

async function openStore() {
  if (!useMongo) {
    const { createMemoryStore } = await import('../packages/server/dist/store/memory.store.js');
    return { store: createMemoryStore(), kind: 'memory', stop: async () => undefined };
  }
  const { MongoMemoryServer } = await importFromStoreMongo('mongodb-memory-server');
  const { MongoClient } = await importFromStoreMongo('mongodb');
  const { createMongoStore } = await import('../packages/store-mongo/dist/index.js');
  const { apply } = await import('../packages/store-mongo/dist/migrate.js');
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri('chokh_load'));
  await client.connect();
  const store = await createMongoStore({ client });
  // The indexes come from the migration, never from the adapter, so the number is
  // measured against the database an operator would actually have.
  await apply(store.db);
  return {
    store,
    kind: 'mongodb',
    stop: async () => {
      await client.close();
      await server.stop();
    },
  };
}

// One connection's batch: its own visitor, its own page.
function body(seat) {
  const now = Date.now();
  return JSON.stringify({
    siteId: SITE_ID,
    sentAt: now,
    hostname: HOSTNAME,
    visitorId: `v_${seat}`,
    lang: 'en-GB',
    screen: '1920x1080',
    viewport: '1920x945',
    events: [
      {
        type: 'event',
        ts: now,
        name: 'cta_click',
        path: `/p/${seat}`,
        title: 'A page',
        referrer: 'https://www.google.com/',
      },
    ],
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const at = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, at)];
}

async function run(origin, options) {
  const latencies = [];
  let seats = 0;
  const result = await autocannon({
    url: `${origin}/api/collect`,
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      origin: `https://${HOSTNAME}`,
      'user-agent': USER_AGENT,
    },
    body: body(0),
    connections: CONNECTIONS,
    ...options,
    setupClient: (client) => {
      seats += 1;
      client.setBody(body(seats));
      // Every response, so the percentile is exact rather than read off
      // autocannon's fixed list, which has a p90 and a p97.5 and no p95.
      client.on('response', (_status, _bytes, responseTime) => latencies.push(responseTime));
    },
  });
  latencies.sort((left, right) => left - right);
  return { result, latencies };
}

async function main() {
  process.env.LOG_LEVEL ??= 'warn';
  // One address sending 12,000 batches a minute is the whole point of the test, and
  // the per-address limit exists to stop exactly that. Raised for the run rather
  // than measured: what is being measured is how fast a batch is accepted.
  process.env.COLLECT_RATE_LIMIT_IP = '10000000';
  process.env.COLLECT_RATE_LIMIT_SITE = '10000000';

  const { buildApp } = await import('../packages/server/dist/app.js');
  const { defaultSiteSettings } = await import('../packages/store/dist/index.js');

  const opened = await openStore();
  await opened.store.createSite({
    id: SITE_ID,
    name: 'Load test',
    domains: [HOSTNAME],
    settings: defaultSiteSettings({ timezone: 'UTC', visitorIdMode: 'persistent' }),
  });

  const app = await buildApp({ store: opened.store });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  console.warn(`chokh load test: POST /api/collect at ${REQUESTS_PER_SECOND} req/s for ${SECONDS}s`);
  console.warn(`adapter: ${opened.kind}   target: ${origin}/api/collect`);

  // A short warm-up, so the first measurement is not the JIT and the first geo
  // lookup.
  await run(origin, { connections: 5, duration: 3 });
  await delay(200);

  const { result, latencies } = await run(origin, {
    overallRate: REQUESTS_PER_SECOND,
    duration: SECONDS,
  });

  const round = (value) => Math.round(value * 100) / 100;
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);
  console.warn(
    [
      '',
      `${opened.kind} adapter:`,
      `  requests   ${result.requests.total} in ${result.duration}s (${result.requests.average}/s)`,
      `  measured   p50 ${round(p50)} ms, p95 ${round(p95)} ms, p99 ${round(p99)} ms, over ${latencies.length} responses`,
      // Printed beside the measured ones because autocannon rounds to whole
      // milliseconds and has no p95, and two sources of a number should be visible
      // rather than quietly reconciled.
      `  autocannon p50 ${result.latency.p50} ms, p90 ${result.latency.p90} ms, p97.5 ${result.latency.p97_5} ms, max ${result.latency.max} ms`,
      `  statuses   ${JSON.stringify(result.statusCodeStats)}`,
      `  errors     ${result.errors} (timeouts ${result.timeouts})`,
    ].join('\n'),
  );

  await app.close();
  await opened.store.close();
  await opened.stop();

  const failures = [];
  if (result.non2xx > 0) failures.push(`${result.non2xx} responses were not 2xx`);
  if (result.errors > 0) failures.push(`${result.errors} requests errored`);
  if (!(p95 <= P95_BUDGET_MS)) {
    failures.push(`p95 was ${round(p95)} ms, over the ${P95_BUDGET_MS} ms budget`);
  }
  if (result.requests.average < REQUESTS_PER_SECOND * 0.9) {
    failures.push(`only ${result.requests.average} req/s were sustained`);
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.warn(`\nOK: p95 ${round(p95)} ms of ${P95_BUDGET_MS} ms, every response 2xx`);
}

await main();
