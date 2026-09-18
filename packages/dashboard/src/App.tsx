import type { JSX } from 'react';

import { messages } from './messages/en';

export function App(): JSX.Element {
  return (
    <main>
      <h1>{messages.appName}</h1>
      <p>{messages.tagline}</p>
      <p>{messages.status}</p>
    </main>
  );
}
