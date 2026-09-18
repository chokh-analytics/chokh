import { join } from 'node:path';

import { DATABASE_FILE, openReader, startGeoRefresh } from '@chokh/geo';

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createSwappableGeoReader } from './plugins/geo.js';

const geo = createSwappableGeoReader(await openReader(join(env.GEOIP_DIR, DATABASE_FILE)));
const app = await buildApp({ geo: geo.reader });

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
    stopGeoRefresh();
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error({ err: error }, 'server failed to start');
  process.exit(1);
}
