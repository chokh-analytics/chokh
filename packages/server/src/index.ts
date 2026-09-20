// The surface an extension is written against.
//
// Not the package's main entry: that is server.ts, which opens a store and
// starts listening, and importing it would boot a second server. An extension
// imports this file by its built path instead, and gets the app builder, the
// envelope, the deps every route is handed and the extension contract itself.
//
// Keeping it to one file is the point. What is exported here is what
// packages/ee may rely on, and anything it wants that is not here is a
// conversation about the seam rather than a deeper import.
export { buildApp, type AppOptions } from './app.js';
export { fail, ok } from './lib/envelope.js';
export type { ApiDeps } from './lib/api-deps.js';
export {
  unlicensed,
  type LicenseStatus,
  type LicenseStatusProvider,
  type ServerExtension,
} from './plugins/extensions.js';
export { requirePrincipal, requireSiteScope } from './plugins/auth.js';
export type { AuthDeps } from './services/auth.service.js';
