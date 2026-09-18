import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

import { extract } from 'tar';

export const DATABASE_FILE = 'city.mmdb';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export interface DatabaseSource {
  name: string;
  url: string;
  archive: 'tar.gz' | 'gz';
}

function month(date: Date, back: number): string {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

// With a license key the product reads MaxMind's GeoLite2-City. Without one it
// falls back to DB-IP Lite City, which needs no account, so a keyless install
// still knows where its visitors are. DB-IP publishes monthly and the current
// month can lag by a day or two, hence the previous month as a second try.
export function databaseSources(licenseKey: string | undefined, now: Date): DatabaseSource[] {
  if (licenseKey !== undefined && licenseKey !== '') {
    return [
      {
        name: 'GeoLite2-City',
        url:
          'https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City' +
          `&license_key=${encodeURIComponent(licenseKey)}&suffix=tar.gz`,
        archive: 'tar.gz',
      },
    ];
  }
  return [0, 1].map((back) => ({
    name: `DB-IP Lite City ${month(now, back)}`,
    url: `https://download.db-ip.com/free/dbip-city-lite-${month(now, back)}.mmdb.gz`,
    archive: 'gz' as const,
  }));
}

export async function needsRefresh(path: string, now: Date): Promise<boolean> {
  try {
    const info = await stat(path);
    return now.getTime() - info.mtimeMs > MAX_AGE_MS;
  } catch {
    return true;
  }
}

async function fetchInto(source: DatabaseSource, dir: string): Promise<string> {
  const response = await fetch(source.url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    // The url carries the license key, so the status is all that is reported.
    throw new Error(`${source.name} download failed with status ${response.status}`);
  }
  const body = Readable.fromWeb(response.body);

  if (source.archive === 'gz') {
    const target = join(dir, `${DATABASE_FILE}.download`);
    await pipeline(body, createGunzip(), createWriteStream(target));
    return target;
  }

  // MaxMind ships a tarball holding one .mmdb inside a dated directory.
  await pipeline(body, createGunzip(), extract({ cwd: dir, strip: 1, filter: (p) => p.endsWith('.mmdb') }));
  return join(dir, 'GeoLite2-City.mmdb');
}

export interface RefreshOptions {
  dir: string;
  licenseKey?: string | undefined;
  now?: Date;
}

// Downloads the database and swaps it into place in one rename, so a reader
// never opens a half written file. Safe to run twice.
export async function refreshDatabase(options: RefreshOptions): Promise<string> {
  const { dir, licenseKey } = options;
  const now = options.now ?? new Date();
  await mkdir(dir, { recursive: true });

  const sources = databaseSources(licenseKey, now);
  let last: unknown;
  for (const source of sources) {
    try {
      const downloaded = await fetchInto(source, dir);
      const target = join(dir, DATABASE_FILE);
      await rename(downloaded, target);
      return source.name;
    } catch (error) {
      last = error;
    }
  }
  await rm(join(dir, `${DATABASE_FILE}.download`), { force: true });
  throw last instanceof Error ? last : new Error('no geo database source could be reached');
}

export interface ScheduleOptions extends RefreshOptions {
  onInstalled(path: string, name: string): Promise<void> | void;
  onError(error: unknown): void;
}

// The monthly refresh, written as a daily staleness check so a process that
// restarts often still updates, and one that runs for months still does.
export function startGeoRefresh(options: ScheduleOptions): () => void {
  const path = join(options.dir, DATABASE_FILE);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running || !(await needsRefresh(path, new Date()))) {
      return;
    }
    running = true;
    try {
      const name = await refreshDatabase(options);
      await options.onInstalled(path, name);
    } catch (error) {
      options.onError(error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), CHECK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
