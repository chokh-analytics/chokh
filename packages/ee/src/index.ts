import type { ServerExtension } from '@chokh/server';

import { buildExtension } from './extension.js';
import { readLicenseKey } from './license/env.js';
import { PUBLIC_KEYS } from './license/public-key.js';

// Chokh Pro: everything in this package runs under the Chokh Enterprise Licence
// in the LICENSE file beside this source, and not under the MIT licence the
// rest of the repository carries.
//
// The core loads this through packages/server/src/lib/load-extensions.ts and
// runs perfectly without it. Nothing here is required by anything there, which
// is what makes the free product a complete product rather than a demo.
//
// The key is read once, here, when this module is first imported. The clock is
// read on every request, so a key that runs out at midnight stops working at
// midnight without anybody restarting anything.

export const extension: ServerExtension = buildExtension(
  {
    raw: readLicenseKey(),
    publicKeys: PUBLIC_KEYS,
  },
  // The one install whose tick runs: the server's. Delivery is read from the
  // environment by the reader in license/env.ts, the same way the key is.
  { tick: true },
);

// For the tests on both sides of the seam, and for nothing else. The extension
// above reads the environment at import; a test that wants to be a licensed
// install builds its own.
export { buildExtension } from './extension.js';
export { PING_FEATURE } from './routes/ee.routes.js';
export { ALERTS_FEATURE } from './alerts/conditions.js';
export { DIGESTS_FEATURE } from './digests/period.js';
