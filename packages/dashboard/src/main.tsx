import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';

// Order matters, and it is the order a browser needs rather than the order that
// reads best: the faces first so nothing has to reflow when they arrive, then
// the tokens every other rule reads, then the base layer that reads them.
import './theme/fonts.css';
import './theme/tokens.css';
import './theme/base.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
