import { installDemoApi } from './demo-api.js';
import { installDemoDownloads } from './downloads.js';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from 'wouter';

import { App } from '../app/App.js';
import { DemoBanner } from './Banner.js';

import '../theme/fonts.css';
import '../theme/tokens.css';
import '../theme/base.css';

// The demo build's entry (demo.html, vite.demo.config.ts): the dashboard as
// it is, with its API answered in the page and its addresses under the base
// path the docs site serves it from.
installDemoApi();
// A report's Download link goes to /api, which nothing answers here.
installDemoDownloads();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element not found');
}

// The base path without its last slash, as the router wants it: /chokh/demo.
const base = import.meta.env.BASE_URL.replace(/\/$/, '');
// The docs are the folder above the demo's.
const docs = `${base.replace(/\/[^/]*$/, '')}/`;

createRoot(container).render(
  <StrictMode>
    <DemoBanner docs={docs} />
    <Router base={base}>
      <App />
    </Router>
  </StrictMode>,
);
