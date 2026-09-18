// The same load test as `load-collect.mjs`, pointed at an install that is already
// running instead of one this process builds. It exists because the number that
// matters is measured where the product runs: a laptop's loopback and disk say
// nothing about a container in Singapore talking to a managed database in the
// same region, and that round trip is most of what one `ingest` costs.
//
//   node scripts/load-collect-remote.mjs --url http://127.0.0.1:4100 --bootstrap
//
// It has no dependencies, so it runs inside the deployment's own image:
//
//   docker cp scripts/load-collect-remote.mjs <container>:/tmp/load.mjs
//   docker exec <container> node /tmp/load.mjs --bootstrap
//
// What the number covers is what the other script's covers: the collector
// accepting a batch and answering 202, with the origin check, the geo lookup, the
// user agent parse, the bot heuristic, the dedupe, the session fold and the write
// to the store all inside the measurement, plus the network between this process
// and the collector and between the collector and its database.
//
// The load is shaped the same way too, and for the same reasons: the site is in
// persistent mode, each connection carries its own visitor id, and the event is a
// custom event rather than a pageview, so neither the one-visitor write hotspot
// nor the pageview dedupe hides the store. The percentile is computed from every
// response.
//
// Run it against a throwaway install, never a live one. It writes thousands of
// rows under a site of its own, and `--bootstrap` is deliberately the only way it
// can create that site: registration is open on an install with no accounts and
// refused on one with any, so pointing this at a real deployment fails at the
// first request instead of filling somebody's reports with `cta_click`.
//
// The collector's per-address limit applies to every one of these batches, because
// they all arrive from one address. Give the throwaway a limit that lets the test
// through:
//
//   -e COLLECT_RATE_LIMIT_IP=10000000 -e COLLECT_RATE_LIMIT_SITE=10000000

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}

function option(name, fallback) {
  const at = args.indexOf(`--${name}`);
  if (at === -1 || at + 1 >= args.length) {
    return fallback;
  }
  return args[at + 1];
}

const TARGET = new URL(option('url', 'http://127.0.0.1:4100'));
const SITE_ID = option('site', 'load_test');
const HOSTNAME = option('domain', 'load.test');
const REQUESTS_PER_SECOND = Number(option('rate', '200'));
const SECONDS = Number(option('seconds', '20'));
const CONNECTIONS = Number(option('connections', '20'));
// Thirty rather than the twenty the in-process script holds itself to. That
// budget describes a request path with the database beside it; this one includes
// a real network hop to a managed database, and thirty is what the AN-API01
// review set for a deployment.
const P95_BUDGET_MS = Number(option('budget', '30'));
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const secure = TARGET.protocol === 'https:';
const send = secure ? httpsRequest : httpRequest;
const agent = secure
  ? new HttpsAgent({ keepAlive: true, maxSockets: CONNECTIONS })
  : new HttpAgent({ keepAlive: true, maxSockets: CONNECTIONS });

function post(path, options = {}) {
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const request = send(
      {
        agent,
        protocol: TARGET.protocol,
        hostname: TARGET.hostname,
        port: TARGET.port === '' ? undefined : TARGET.port,
        path,
        method: options.method ?? 'POST',
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            ms: Number(process.hrtime.bigint() - started) / 1e6,
          });
        });
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

function json(path, body, cookie) {
  return post(path, {
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

// One connection's batch: its own visitor, its own page.
function batch(seat) {
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

function collect(seat) {
  return post('/api/collect', {
    headers: {
      'content-type': 'text/plain',
      origin: `https://${HOSTNAME}`,
      'user-agent': USER_AGENT,
    },
    body: batch(seat),
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const at = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, at)];
}

// The first account of an install owns it and is signed in by the response, which
// is also why this can only ever run against an install nobody has registered on.
async function bootstrap() {
  const email = `load-${randomUUID()}@example.invalid`;
  // Never printed, never stored: it belongs to an account in a database this run
  // is about to throw away.
  const password = randomBytes(24).toString('base64url');

  const registered = await json('/api/auth/register', { email, password });
  if (registered.status === 403) {
    throw new Error(
      'This install already has an account, so it is not a throwaway. Point --url at one with an empty database.',
    );
  }
  if (registered.status !== 201) {
    throw new Error(`Registration answered ${registered.status}: ${registered.body}`);
  }
  const cookies = registered.headers['set-cookie'] ?? [];
  const cookie = cookies.map((value) => String(value).split(';')[0]).join('; ');
  if (cookie === '') {
    throw new Error('Registration set no session cookie, so the site cannot be created');
  }

  const site = await json(
    '/api/sites',
    {
      id: SITE_ID,
      name: 'Load test',
      domains: [HOSTNAME],
      // Persistent, so the visitor id each connection sends is the visitor it is
      // counted as. In cookieless mode one address and one user agent is one
      // visitor, and every batch would land on one session document.
      settings: { visitorIdMode: 'persistent' },
    },
    cookie,
  );
  if (site.status !== 201) {
    throw new Error(`Creating the site answered ${site.status}: ${site.body}`);
  }
}

async function run({ seconds, rate, connections }) {
  const latencies = [];
  const statuses = new Map();
  let errors = 0;
  let dispatched = 0;
  const interval = 1000 / rate;
  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1000;

  async function seat(index) {
    for (;;) {
      const at = dispatched++;
      const due = startedAt + at * interval;
      if (due >= deadline) {
        return;
      }
      const wait = due - Date.now();
      if (wait > 0) {
        await delay(wait);
      }
      try {
        const response = await collect(index);
        latencies.push(response.ms);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      } catch {
        errors += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: connections }, (_unused, index) => seat(index)));
  const elapsed = (Date.now() - startedAt) / 1000;
  latencies.sort((left, right) => left - right);
  return { latencies, statuses, errors, elapsed };
}

// The driver comes from the adapter package rather than from here, the way the
// in-process script resolves it, because a pnpm workspace does not hoist and the
// image installs nothing at its root. Which adapter package, though, depends on
// where this file was copied to: beside the repository in a checkout, and
// wherever `docker cp` put it in a container. Both are tried rather than assumed,
// because the first version assumed the checkout and died at the last line of an
// otherwise finished run, leaving the database it was about to drop.
function storeMongoPackage() {
  const candidates = [
    new URL('../packages/store-mongo/package.json', import.meta.url),
    // The image's WORKDIR. `docker cp` anywhere plus `docker exec node` lands here.
    pathToFileURL('/app/packages/store-mongo/package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'Could not find packages/store-mongo beside this script or at /app, so the mongodb driver cannot be resolved',
  );
}

// The database this run wrote to, emptied afterwards.
async function dropDatabase() {
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || uri === '') {
    throw new Error('--drop-database needs MONGODB_URI, which is the database it drops');
  }
  const fromStoreMongo = createRequire(storeMongoPackage());
  const { MongoClient } = await import(
    pathToFileURL(fromStoreMongo.resolve('mongodb')).href
  );
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collections = await db.listCollections().toArray();
  for (const collection of collections) {
    await db.collection(collection.name).drop();
  }
  // And the database itself, when the user is allowed to. Often it is not: on a
  // managed cluster the application user holds readWriteAnyDatabase, and
  // dropDatabase belongs to dbAdmin. Dropping the collections is what actually
  // empties it, and a database with none left is gone from every listing, so a
  // refusal here is not a failure.
  try {
    await db.dropDatabase();
  } catch {
    // Not permitted, and not needed.
  }
  await client.close();
  return `${db.databaseName}, ${collections.length} collections`;
}

async function main() {
  console.warn(`chokh load test: POST ${TARGET.origin}/api/collect`);
  console.warn(`  ${REQUESTS_PER_SECOND} req/s for ${SECONDS}s over ${CONNECTIONS} connections`);

  if (flag('bootstrap')) {
    await bootstrap();
    console.warn(`  bootstrapped site ${SITE_ID} on ${HOSTNAME}`);
  }

  // A short warm-up, so the first measurement is not the JIT, the first geo
  // lookup and the connection pool opening.
  await run({ seconds: 3, rate: 25, connections: 5 });
  await delay(200);

  const { latencies, statuses, errors, elapsed } = await run({
    seconds: SECONDS,
    rate: REQUESTS_PER_SECOND,
    connections: CONNECTIONS,
  });

  const round = (value) => Math.round(value * 100) / 100;
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);
  const total = latencies.length + errors;
  const accepted = statuses.get(202) ?? 0;
  console.warn(
    [
      '',
      `${TARGET.origin}:`,
      `  requests   ${total} in ${round(elapsed)}s (${round(total / elapsed)}/s)`,
      `  measured   p50 ${round(p50)} ms, p95 ${round(p95)} ms, p99 ${round(p99)} ms, over ${latencies.length} responses`,
      `  max        ${round(latencies[latencies.length - 1] ?? Number.NaN)} ms`,
      `  statuses   ${JSON.stringify(Object.fromEntries(statuses))}`,
      `  errors     ${errors}`,
    ].join('\n'),
  );

  // Keep-alive sockets would hold the event loop open long after the last
  // response, which reads as a run that has not finished.
  agent.destroy();

  if (flag('drop-database')) {
    try {
      const name = await dropDatabase();
      console.warn(`  dropped    ${name}`);
    } catch (error) {
      // Loudly, and as a failure: a throwaway database nobody knows is there is
      // how a cluster fills up with the leavings of tests that said they passed.
      console.error(`  NOT DROPPED: ${error instanceof Error ? error.message : String(error)}`);
      console.error('  The database this run wrote to is still there. Drop it by hand.');
      process.exitCode = 1;
    }
  }

  const failures = [];
  if (accepted !== latencies.length) {
    failures.push(`${latencies.length - accepted} responses were not 202`);
  }
  if (errors > 0) {
    failures.push(`${errors} requests errored`);
  }
  if (!(p95 <= P95_BUDGET_MS)) {
    failures.push(`p95 was ${round(p95)} ms, over the ${P95_BUDGET_MS} ms budget`);
  }
  if (total / elapsed < REQUESTS_PER_SECOND * 0.9) {
    failures.push(`only ${round(total / elapsed)} req/s were sustained`);
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.warn(`\nOK: p95 ${round(p95)} ms of ${P95_BUDGET_MS} ms, every response 202`);
}

await main();
