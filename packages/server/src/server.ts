import { join } from 'node:path';

import { DATABASE_FILE, openReader, startGeoRefresh } from '@chokh/geo';

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { loadExtensions } from './lib/load-extensions.js';
import { openBus, openOnce } from './plugins/bus.js';
import { createSwappableGeoReader } from './plugins/geo.js';
import { openPresence } from './plugins/presence.js';
import { openStore } from './plugins/store.js';
import { startJobs } from './services/jobs.js';

const geo = createSwappableGeoReader(await openReader(join(env.GEOIP_DIR, DATABASE_FILE)));
const { presence, kind: presenceKind } = openPresence();
const { store, kind, version } = await openStore(presence);
const { bus, kind: busKind } = openBus();
const { once } = openOnce(() => Date.now());
const loaded = await loadExtensions();
const app = await buildApp({ geo: geo.reader, store, bus, once, extensions: loaded.extensions });
app.log.info(
  { store: kind, ...(version === undefined ? {} : { version }), presence: presenceKind, bus: busKind },
  'storage adapter opened',
);
if (loaded.reason === 'failed') {
  // Present and broken. The process carries on serving the free product rather
  // than refusing to boot, and says loudly what it is missing.
  app.log.error({ err: loaded.error }, 'the paid extension failed to load, running the core only');
} else {
  // "absent" is a complete install of the free product, so this is info and
  // never a warning: nobody should read a line about a licence they did not buy
  // and wonder what they did wrong.
  app.log.info({ extensions: loaded.reason }, 'extensions');
}

// The three background jobs. The rollup and the retention purge run on one
// hourly tick; the geo refresh checks daily and downloads when the database is
// over a month old. All three are idempotent and safe to run twice, so two
// processes of one install need no leader between them.
const stopJobs = startJobs({
  store,
  log: {
    info: (details, message) => app.log.info(details, message),
    warn: (details, message) => app.log.warn(details, message),
  },
  now: () => Date.now(),
});

const stopGeoRefresh = startGeoRefresh({
  dir: env.GEOIP_DIR,
  licenseKey: env.GEOIP_LICENSE_KEY,
  onInstalled: async (path, name) => {
    geo.set(await openReader(path));
    app.log.info({ database: name }, 'geo database installed');
  },
  onError: (error) => {
    app.log.warn({ err: error }, 'geo database refresh failed, lookups answer empty until it works');
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopJobs();
    stopGeoRefresh();
    void app
      .close()
      .then(() => store.close())
      .then(() => presence.close())
      .then(() => bus.close())
      .then(() => once.close())
      .then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error({ err: error }, 'server failed to start');
  process.exit(1);
}
