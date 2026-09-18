import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { DATABASE_FILE, databaseSources, needsRefresh } from './download.js';

const NOW = new Date('2026-09-18T00:00:00Z');

describe('databaseSources', () => {
  it('reads GeoLite2-City when a license key is set', () => {
    const sources = databaseSources('secret-key', NOW);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.name).toBe('GeoLite2-City');
    expect(sources[0]?.archive).toBe('tar.gz');
    expect(sources[0]?.url).toContain('edition_id=GeoLite2-City');
    expect(sources[0]?.url).toContain('license_key=secret-key');
  });

  it('falls back to DB-IP Lite with no key, this month and then last month', () => {
    const sources = databaseSources(undefined, NOW);
    expect(sources.map((source) => source.url)).toEqual([
      'https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz',
      'https://download.db-ip.com/free/dbip-city-lite-2026-08.mmdb.gz',
    ]);
    expect(sources.every((source) => source.archive === 'gz')).toBe(true);
  });

  it('treats an empty key as no key', () => {
    expect(databaseSources('', NOW)[0]?.name).toContain('DB-IP Lite');
  });

  it('steps back over a year boundary', () => {
    const sources = databaseSources(undefined, new Date('2026-01-04T00:00:00Z'));
    expect(sources[1]?.url).toContain('2025-12');
  });
});

describe('needsRefresh', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chokh-geo-'));
  });

  it('is true when no database has been installed yet', async () => {
    await expect(needsRefresh(join(dir, 'missing.mmdb'), NOW)).resolves.toBe(true);
  });

  it('is false for a database installed this month', async () => {
    const path = join(dir, DATABASE_FILE);
    await writeFile(path, 'not a real database');
    const fresh = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    await utimes(path, fresh, fresh);
    await expect(needsRefresh(path, NOW)).resolves.toBe(false);
  });

  it('is true once the database is older than a month', async () => {
    const path = join(dir, DATABASE_FILE);
    await writeFile(path, 'not a real database');
    const stale = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
    await utimes(path, stale, stale);
    await expect(needsRefresh(path, NOW)).resolves.toBe(true);
  });
});
