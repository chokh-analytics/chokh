import { fixture, runStoreConformance } from '@chokh/store/conformance';

import { createMemoryStore } from './memory.store.js';

// Repository rule 5: every adapter passes the one conformance suite, and the
// in-memory adapter is an adapter. Running it here is also what keeps the
// suite honest: an assertion that only MongoDB can satisfy is a bug in the
// suite, not in the other adapter.
runStoreConformance('memory', () => {
  const store = createMemoryStore([], { now: () => fixture.NOW });
  return Promise.resolve({
    store,
    addSite: (site) => {
      store.addSite(site);
      return Promise.resolve();
    },
    reset: () => {
      store.clear();
      return Promise.resolve();
    },
    close: () => store.close(),
  });
});
