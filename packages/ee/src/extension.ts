import type { FastifyInstance } from 'fastify';
import type { ApiDeps, LicenseStatus, ServerExtension } from '@chokh/server';

import { createDeliverer, type Deliverer } from './alerts/deliver.js';
import { readDeliveryEnv, readOidcEnv, type DeliveryEnv, type OidcEnv } from './license/env.js';
import type { OidcClient } from './oidc/client.js';
import { OIDC_FEATURE } from './oidc/oidc.routes.js';
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
  // Signing in through an identity provider. The server reads the
  // environment; a test hands in a configuration of its own (null for none),
  // and may stand a client of its own between this and the provider.
  oidc?: OidcEnv | null;
  oidcClient?: OidcClient;
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
    // All four values or it is off, and one line says which are missing, by
    // name and never by value. An install that set none of them is not told
    // anything: it did not ask.
    let oidc: OidcEnv | null = null;
    if (options.oidc !== undefined) {
      oidc = options.oidc;
    } else {
      const read = readOidcEnv();
      if ('config' in read) {
        oidc = read.config;
        if (!state.allows(OIDC_FEATURE, Date.now()).ok) {
          app.log.warn('OIDC sign-in is configured, and this install has no licence key that includes it, so it is off');
        }
      } else if (read.missing.filter((name) => name.startsWith('CHOKH_OIDC_')).length < 3) {
        // At least one of its own three was set, so somebody meant to turn it
        // on: say what is still missing.
        app.log.warn({ missing: read.missing }, 'OIDC sign-in is off: some of its settings are missing');
      }
    }
    await registerEeRoutes(app, deps, state, {
      deliver,
      delivery,
      publicUrl: delivery.publicUrl,
      tick: options.tick ?? false,
      oidc,
      ...(options.oidcClient === undefined ? {} : { oidcClient: options.oidcClient }),
    });
  }

  return { name: '@chokh/ee', register, license };
}
