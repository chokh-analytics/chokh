import { routeKey } from '@chokh/server';
import { describe, expect, it } from 'vitest';

import { EE_ROUTE_DOCS } from './route-docs.js';
import { EE_ROUTES } from './route-table.js';

// Every paid route has its line in the API reference, once.
describe('the API reference of packages/ee', () => {
  it('says something about every route, once, and about nothing that is not a route', () => {
    const documented = EE_ROUTE_DOCS.flatMap((group) => Object.keys(group.routes));
    expect(new Set(documented).size).toBe(documented.length);
    expect([...documented].sort()).toEqual(EE_ROUTES.map(routeKey).sort());
  });

  it('gives every route a sentence that ends like one', () => {
    for (const group of EE_ROUTE_DOCS) {
      for (const [key, doc] of Object.entries(group.routes)) {
        expect(doc.summary, key).toMatch(/^[A-Z].{10,}\.$/);
      }
    }
  });
});
