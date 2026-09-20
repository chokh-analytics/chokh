import type { FastifyInstance } from 'fastify';
import type { ApiDeps, LicenseStatus, ServerExtension } from '@chokh/server/dist/index.js';

// Chokh Pro: everything in this package runs under the Chokh Enterprise Licence
// in the LICENSE file beside this source, and not under the MIT licence the
// rest of the repository carries.
//
// The core loads this through packages/server/src/lib/load-extensions.ts and
// runs perfectly without it. Nothing here is required by anything there, which
// is what makes the free product a complete product rather than a demo.
//
// The frame lands before the features do (AN-EE01). This file is the shape of
// the seam; the key, the guard and the first gated route follow in the commits
// after it.

function license(): LicenseStatus {
  return { licensed: false, plan: null, licensee: null, expiresAt: null, features: [] };
}

async function register(_app: FastifyInstance, _deps: ApiDeps): Promise<void> {
  // Nothing yet. The licence verifier and the routes it gates arrive next.
}

export const extension: ServerExtension = { name: '@chokh/ee', register, license };
