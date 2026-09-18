import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { emptyReader, openReader, toGeoLocation, type CityRecord } from './ip.js';

// A record shaped the way GeoLite2-City and DB-IP Lite City answer for an
// address they know well.
const DHAKA: CityRecord = {
  country: { iso_code: 'BD' },
  subdivisions: [{ names: { en: 'Dhaka Division' } }],
  city: { names: { en: 'Dhaka' } },
  location: { latitude: 23.7104, longitude: 90.4074, time_zone: 'Asia/Dhaka' },
};

describe('toGeoLocation', () => {
  it('reads every field a full record carries', () => {
    expect(toGeoLocation(DHAKA)).toEqual({
      country: 'BD',
      region: 'Dhaka Division',
      city: 'Dhaka',
      lat: 23.7104,
      lon: 90.4074,
      tz: 'Asia/Dhaka',
    });
  });

  it('keeps only what a country-only record knows', () => {
    expect(toGeoLocation({ country: { iso_code: 'US' } })).toEqual({ country: 'US' });
  });

  it('falls back to the registered country when the address has no country', () => {
    expect(toGeoLocation({ registered_country: { iso_code: 'SG' } })).toEqual({ country: 'SG' });
  });

  it('is empty for an address the database does not know', () => {
    expect(toGeoLocation(null)).toEqual({});
    expect(toGeoLocation(undefined)).toEqual({});
    expect(toGeoLocation({})).toEqual({});
  });

  it('keeps a zero coordinate, which is a place and not a missing value', () => {
    expect(toGeoLocation({ location: { latitude: 0, longitude: 0 } })).toEqual({ lat: 0, lon: 0 });
  });
});

describe('emptyReader', () => {
  it('knows nothing, so an install without a database still ingests', () => {
    expect(emptyReader.lookup('103.87.1.1')).toEqual({});
  });
});

describe('openReader', () => {
  it('knows nothing when no database has been installed yet', async () => {
    const reader = await openReader(join(tmpdir(), 'chokh-no-such-database.mmdb'));
    expect(reader.lookup('103.87.1.1')).toEqual({});
  });

  it('knows nothing rather than failing to start on a corrupt download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chokh-geo-bad-'));
    const path = join(dir, 'city.mmdb');
    await writeFile(path, 'this is not a database');

    const reader = await openReader(path);
    expect(reader.lookup('103.87.1.1')).toEqual({});
  });
});
