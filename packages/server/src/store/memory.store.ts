import type { AnalyticsStore, Site, StoredEvent } from './AnalyticsStore.js';

export interface MemoryStore extends AnalyticsStore {
  addSite(site: Site): void;
  stored(): StoredEvent[];
  clear(): void;
}

// The adapter the tests read through, and what a fresh install runs on until
// AN-STO01 lands the MongoDB adapter. Nothing here survives a restart.
export function createMemoryStore(sites: Site[] = []): MemoryStore {
  const bySiteId = new Map<string, Site>(sites.map((site) => [site.id, site]));
  let events: StoredEvent[] = [];

  return {
    addSite(site: Site): void {
      bySiteId.set(site.id, site);
    },
    site(siteId: string): Promise<Site | null> {
      return Promise.resolve(bySiteId.get(siteId) ?? null);
    },
    ingest(batch: StoredEvent[]): Promise<void> {
      events = events.concat(batch);
      return Promise.resolve();
    },
    stored(): StoredEvent[] {
      return events;
    },
    clear(): void {
      events = [];
    },
  };
}
