// @chokh/next: the Chokh tracker in a Next.js App Router app, first-party.
//
//   next.config.mjs        withChokh(config, { url })      from '@chokh/next/config'
//   app/%5Fpa/collect/route.ts  createCollectRoute(...)   from '@chokh/next/collect'
//   app/layout.tsx         <Analytics site="my_site" />    from '@chokh/next'
//
// The hooks and functions are @chokh/react's, re-exported, not copied. No
// tracker code is in this package.

export { Analytics, type AnalyticsProps } from './analytics.js';
export { ChokhConsent } from './consent.js';
export {
  consent,
  identify,
  reset,
  track,
  useChokh,
  useConsent,
  useTrack,
  type Chokh,
  type ChokhProps,
} from '@chokh/react';
