import { describe, expect, it } from 'vitest';

import { CORE_ROUTE_DOCS } from './route-docs.js';
import { CORE_ROUTES, routeKey } from './route-table.js';

// The API reference is generated from route-docs.ts and the route table, so
// every route of the table has a line in it, once, and nothing else does.
describe('the API reference of the core', () => {
  it('says something about every route, once, and about nothing that is not a route', () => {
    const documented = CORE_ROUTE_DOCS.flatMap((group) => Object.keys(group.routes));
    expect(new Set(documented).size).toBe(documented.length);
    expect([...documented].sort()).toEqual(CORE_ROUTES.map(routeKey).sort());
  });

  it('gives every route a sentence that ends like one', () => {
    for (const group of CORE_ROUTE_DOCS) {
      for (const [key, doc] of Object.entries(group.routes)) {
        expect(doc.summary, key).toMatch(/^[A-Z].{10,}\.$/);
      }
    }
  });
});
