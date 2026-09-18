import { fixture, runAccountConformance, runStoreConformance } from '@chokh/store/conformance';

import { createMemoryStore } from './memory.store.js';

// Repository rule 5: every adapter passes the one conformance suite, and the
// in-memory adapter is an adapter. Running it here is also what keeps the
// suite honest: an assertion that only MongoDB can satisfy is a bug in the
// suite, not in the other adapter.
runStoreConformance('memory', () => {
  const store = createMemoryStore([], { now: () => fixture.NOW });
  return Promise.resolve({
    store,
    addSite: (site) => store.createSite(site),
    reset: () => {
      store.clear();
      return Promise.resolve();
    },
    close: () => store.close(),
  });
});

// The same for the control plane: the accounts, the teams, the keys and the
// audit log answer the same way in both adapters or one of them is wrong.
runAccountConformance('memory', () => {
  const store = createMemoryStore([], { now: () => fixture.NOW });
  return Promise.resolve({
    store,
    reset: () => {
      store.clear();
      return Promise.resolve();
    },
    close: () => store.close(),
  });
});
