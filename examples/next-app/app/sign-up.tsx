'use client';

import { useTrack } from '@chokh/next';

export function SignUp() {
  const track = useTrack();
  return (
    <button type="button" onClick={() => track('signup', { plan: 'pro' })}>
      Sign up
    </button>
  );
}
