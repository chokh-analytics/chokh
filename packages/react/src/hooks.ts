'use client';

import { useCallback, useMemo } from 'react';

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
