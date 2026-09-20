import { describe, expect, it } from 'vitest';

import { extension, PING_FEATURE } from './index.js';

// What this package exports to the core, asserted from this side of the seam.
//
// packages/server proves that it can load an extension and what it does with
// one, and ee.routes.test.ts drives the gate over HTTP against a real server.
// What is left for here is the module the loader actually imports: it is the
// right shape, and on a machine with no CHOKH_LICENSE_KEY it says so rather
// than throwing or claiming anything.

describe('the extension this package exports', () => {
  it('is the shape the core loads', () => {
    expect(extension.name).toBe('@chokh/ee');
    expect(typeof extension.register).toBe('function');
    expect(typeof extension.license).toBe('function');
  });

  // This process has no key, and this build has no issuer, so the honest answer
  // is no licence and nothing else. The same answer a public image gives before
  // anybody has bought anything.
  it('reports no licence on an install with no key', () => {
    expect(process.env['CHOKH_LICENSE_KEY']).toBeUndefined();
    expect(extension.license?.()).toEqual({
      licensed: false,
      plan: null,
      licensee: null,
      expiresAt: null,
      features: [],
    });
  });

  it('names the feature the frame is verified against', () => {
    expect(PING_FEATURE).toBe('ee.ping');
  });
});
