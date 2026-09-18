import { existsSync } from 'node:fs';

import { open, type CityResponse, type Reader } from 'maxmind';

import type { GeoLocation } from './types.js';

// The shape both GeoLite2-City and DB-IP Lite City answer with. Everything is
// optional: the free databases know a country for most addresses, a city for
// fewer, and coordinates for fewer still.
export interface CityRecord {
  country?: { iso_code?: string };
  registered_country?: { iso_code?: string };
  subdivisions?: { names?: { en?: string } }[];
  city?: { names?: { en?: string } };
  location?: { latitude?: number; longitude?: number; time_zone?: string };
}

export function toGeoLocation(record: CityRecord | null | undefined): GeoLocation {
  if (record === null || record === undefined) {
    return {};
  }
  const geo: GeoLocation = {};
  const country = record.country?.iso_code ?? record.registered_country?.iso_code;
  if (country !== undefined) geo.country = country;

  const region = record.subdivisions?.[0]?.names?.en;
  if (region !== undefined) geo.region = region;

  const city = record.city?.names?.en;
  if (city !== undefined) geo.city = city;

  const location = record.location;
  if (location?.latitude !== undefined) geo.lat = location.latitude;
  if (location?.longitude !== undefined) geo.lon = location.longitude;
  if (location?.time_zone !== undefined) geo.tz = location.time_zone;

  return geo;
}

export interface GeoReader {
  lookup(ip: string): GeoLocation;
}

// Nothing is known until a database is installed. The collector carries on and
// stores events without geo rather than refusing them.
export const emptyReader: GeoReader = {
  lookup: () => ({}),
};

// The database is opened once and queried in place, so a lookup costs no
// allocation and no network call.
export async function openReader(path: string): Promise<GeoReader> {
  if (!existsSync(path)) {
    return emptyReader;
  }
  let reader: Reader<CityResponse>;
  try {
    reader = await open<CityResponse>(path);
  } catch {
    // A truncated or corrupt download must not stop the collector. The refresh
    // job replaces the file and the reader is opened again.
    return emptyReader;
  }
  return {
    lookup(ip: string): GeoLocation {
      try {
        return toGeoLocation(reader.get(ip));
      } catch {
        // A malformed address is not worth failing an ingest over.
        return {};
      }
    },
  };
}
