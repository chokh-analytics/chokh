'use client';

import { useConsent } from '@chokh/react';

// The one part of <Analytics /> that runs in the browser: keeps the tracker's
// consent in step with the prop. Renders nothing.
export function ChokhConsent({ consent }: { consent: boolean }): null {
  useConsent(consent);
  return null;
}
