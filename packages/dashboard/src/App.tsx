import type { JSX } from 'react';

import { Splash } from './ui/Splash.js';

// The shell, sign in and the router arrive with the next commit. Until then the
// application is its boot state, which is a real screen and not a placeholder:
// it is what everybody sees for the moment between the first paint and the
// answer to GET /api/me.
export function App(): JSX.Element {
  return <Splash />;
}
