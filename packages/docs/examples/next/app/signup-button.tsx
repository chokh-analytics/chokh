'use client';

import { useTrack } from '@chokh/next';

export function SignupButton() {
  const track = useTrack();
  return <button onClick={() => track('signup', { plan: 'pro' })}>Sign up</button>;
}
