import type { FastifyInstance } from 'fastify';
import type { ApiDeps, LicenseStatus, ServerExtension } from '@chokh/server';

import { createLicenseState, type LicenseState } from './license/state.js';
import { registerEeRoutes } from './routes/ee.routes.js';

// The extension, built from a licence state somebody chose.
//
// index.ts builds the one the server loads, from the environment and the
// public keys in this build. This exists so a test can build a licensed
// install, or an install whose key expires in ninety seconds, without setting
// an environment variable for a module that reads it once at import and
// without ever touching the baked-in public keys.

export interface ExtensionInput {
  raw: string | undefined;
  publicKeys: readonly string[];
}

export function buildExtension(input: ExtensionInput | LicenseState): ServerExtension {
  const state =
    'allows' in input
      ? input
      : createLicenseState({ raw: input.raw, publicKeys: input.publicKeys });

  function license(): LicenseStatus {
    return state.status(Date.now());
  }

  async function register(app: FastifyInstance, deps: ApiDeps): Promise<void> {
    await registerEeRoutes(app, deps, state);
  }

  return { name: '@chokh/ee', register, license };
}
