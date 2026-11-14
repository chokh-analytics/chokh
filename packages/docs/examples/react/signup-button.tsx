import { useTrack } from '@chokh/react';

export function SignupButton() {
  const track = useTrack();
  return <button onClick={() => track('signup', { plan: 'pro' })}>Sign up</button>;
}
