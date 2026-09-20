import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { ApiDeps } from '@chokh/server/dist/index.js';
import { extension } from './index.js';

// The shape the core loads, asserted from this side of the seam.
//
// packages/server proves that it can load an extension and what it does with
// one. This proves that what this package exports is an extension: a name, a
// register that runs, and a licence opinion. The two halves are built and
// released together, so nothing else checks that they still agree.

describe('the extension this package exports', () => {
  it('is the shape the core loads', () => {
    expect(extension.name).toBe('@chokh/ee');
    expect(typeof extension.register).toBe('function');
    expect(typeof extension.license).toBe('function');
  });

  it('registers against a real Fastify instance without throwing', async () => {
    const app = Fastify({ logger: false });
    await extension.register(app, {} as ApiDeps);
    await app.ready();
    await app.close();
  });

  // No key has been read yet, so the honest answer is no licence. When the
  // verifier lands this becomes the answer for an install that has no key, and
  // it stays the answer a core-only build gives for ever.
  it('reports no licence until there is a key to read', () => {
    expect(extension.license?.()).toEqual({
      licensed: false,
      plan: null,
      licensee: null,
      expiresAt: null,
      features: [],
    });
  });
});
