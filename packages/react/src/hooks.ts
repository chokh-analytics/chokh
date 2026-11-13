'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { consent, identify, reset, track, type ChokhProps } from './pa.js';

export interface Chokh {
  track(name: string, props?: ChokhProps): void;
  identify(userId: string, traits?: ChokhProps, signature?: string): void;
  reset(): void;
  consent(granted: boolean): void;
}

// The hooks need no provider: they call the tracker's window.pa (or its queue,
// before it has booted), so they work under <ChokhProvider>, beside
// @chokh/next's <Analytics />, or beside a tag written by hand. What they add
// over the plain functions is identity: the same function on every render, so a
// track in an effect's dependencies does not rerun it.

// const track = useTrack(); track('signup', { plan: 'pro' });
export function useTrack(): (name: string, props?: ChokhProps) => void {
  return useCallback((name: string, props?: ChokhProps) => track(name, props), []);
}

// const { identify, reset, consent } = useChokh();
export function useChokh(): Chokh {
  return useMemo(() => ({ track, identify, reset, consent }), []);
}

// Keep the tracker's consent in step with a value: undefined is no gate, false
// is not granted, true is granted. <ChokhProvider> and @chokh/next's
// <Analytics /> both use it for their consent prop.
//
// A grant is sent, and so is a later withdrawal, each once. The starting false
// is never sent: the tag's data-consent already holds every event until consent
// is granted, and the tracker reads a false as consent withdrawn, which throws
// away what it was holding, the first pageview among it. The last value sent is
// kept in a ref, so strict mode's second run of the effect sends nothing.
export function useConsent(granted: boolean | undefined): void {
  const sent = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (granted === undefined || granted === sent.current) return;
    if (sent.current === undefined && !granted) {
      sent.current = false;
      return;
    }
    sent.current = granted;
    consent(granted);
  }, [granted]);
}
