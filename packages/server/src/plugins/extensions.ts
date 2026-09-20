import type { FastifyInstance } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';

// The seam between the MIT core and packages/ee, declared by the core and
// implemented by nothing in it.
//
// Chokh is open core (ADR-0073): everything here is MIT and free to self-host
// in full, and the paid features live in packages/ee under a second licence and
// run only with a key. One repository, one build, one image, which is how
// GitLab and PostHog do the same thing.
//
// What that costs the core is this file and one other. The core knows that an
// extension is a name and a register function; it does not know what any
// extension does, it never imports one, and it never reads a licence key.
// packages/server/src/lib/load-extensions.ts is the only file in the core that
// knows packages/ee exists at all, and its whole job is to load it if it is
// there and carry on if it is not. Deleting packages/ee leaves a product that
// builds, boots and serves every report, which is the promise the licence makes
// and which CI proves on every push rather than asserting.

// What GET /api/license answers. Never the key itself, and never anything a
// stranger may read: the route needs a session.
export interface LicenseStatus {
  licensed: boolean;
  // The tier, for the dashboard to name. Null when there is no key.
  plan: string | null;
  // Who the key was issued to, shown to signed-in people so they can tell a
  // renewal from a purchase.
  licensee: string | null;
  // Unix milliseconds, so the dashboard can say "expired on" rather than only
  // "not licensed".
  expiresAt: number | null;
  // What this install may run. An empty list is the honest answer with no key.
  features: string[];
}

export type LicenseStatusProvider = () => LicenseStatus;

// No key, and nothing pretending otherwise. This is what a core-only install
// answers for ever, and it is what makes the dashboard's "part of Chokh Pro"
// label work in a build that has no packages/ee in it at all.
export function unlicensed(): LicenseStatus {
  return { licensed: false, plan: null, licensee: null, expiresAt: null, features: [] };
}

export interface ServerExtension {
  // For the boot log, so an operator can see what the process is carrying.
  name: string;
  // Routes, hooks, anything. Registered after every core route and before the
  // not found handler, which would otherwise swallow every path added here.
  register(app: FastifyInstance, deps: ApiDeps): Promise<void>;
  // What the extension knows about this install's licence. The last extension
  // to offer one wins; with no extensions the core answers unlicensed().
  license?: LicenseStatusProvider;
}
