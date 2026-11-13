import { StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { ChokhProvider, useTrack } from '../src/index.js';

// The page the browser case drives: a small single page app under strict mode,
// built in development (where strict mode runs every effect twice), loading the
// real a.js through <ChokhProvider>. Two "routes" changed with pushState, a
// button that tracks, and on ?consent a banner that grants consent.

function Page(): ReactElement {
  const [path, setPath] = useState(window.location.pathname);
  const track = useTrack();
  const go = (to: string): void => {
    window.history.pushState({}, '', to);
    setPath(to);
  };
  return (
    <main>
      <h1>{path === '/' ? 'Home' : 'About'}</h1>
      <button type="button" onClick={() => go('/about')}>
        About
      </button>
      <button type="button" onClick={() => track('signup', { plan: 'pro' })}>
        Sign up
      </button>
    </main>
  );
}

function App(): ReactElement {
  const gated = new URLSearchParams(window.location.search).has('consent');
  const [granted, setGranted] = useState(false);
  return (
    <ChokhProvider site="s_react" src="/a.js" {...(gated ? { consent: granted } : {})}>
      {gated && !granted ? (
        <button type="button" onClick={() => setGranted(true)}>
          Accept
        </button>
      ) : null}
      <Page />
    </ChokhProvider>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
