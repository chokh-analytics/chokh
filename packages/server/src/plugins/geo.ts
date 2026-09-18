import type { GeoReader } from '@chokh/geo';

export interface SwappableGeoReader {
  reader: GeoReader;
  set(next: GeoReader): void;
}

// The geo database is installed by a job that can finish long after the server
// started, so the reader the collector holds is a stable handle over a database
// that can be replaced under it.
export function createSwappableGeoReader(initial: GeoReader): SwappableGeoReader {
  let current = initial;
  return {
    reader: {
      lookup: (ip: string) => current.lookup(ip),
    },
    set(next: GeoReader): void {
      current = next;
    },
  };
}
