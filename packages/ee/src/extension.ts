import type { FastifyInstance } from 'fastify';
import type { ApiDeps, LicenseStatus, ServerExtension } from '@chokh/server';

import { createDeliverer, type Deliverer } from './alerts/deliver.js';
import { readDeliveryEnv, type DeliveryEnv } from './license/env.js';
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

export interface ExtensionOptions {
  // Where messages go. The server reads the environment; a test hands in a
  // fake deliverer, or an environment of its own.
  delivery?: DeliveryEnv;
  deliver?: Deliverer;
  // Whether the alert tick starts when the app is ready. On for the server,
  // off by default for a test that only wants the routes.
  tick?: boolean;
}

export function buildExtension(
  input: ExtensionInput | LicenseState,
  options: ExtensionOptions = {},
): ServerExtension {
  const state =
    'allows' in input
      ? input
      : createLicenseState({ raw: input.raw, publicKeys: input.publicKeys });
  const delivery = options.delivery ?? readDeliveryEnv();
  const deliver = options.deliver ?? createDeliverer({ env: delivery });

  function license(): LicenseStatus {
    return state.status(Date.now());
  }

  async function register(app: FastifyInstance, deps: ApiDeps): Promise<void> {
    await registerEeRoutes(app, deps, state, {
      deliver,
      delivery,
      publicUrl: delivery.publicUrl,
      tick: options.tick ?? false,
    });
  }

  return { name: '@chokh/ee', register, license };
}
