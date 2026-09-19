import type { JSX } from 'react';

import { messages } from '../messages/en.js';
import { Wordmark } from './Wordmark.js';
import styles from './Splash.module.css';

// The boot state. One live region, so a screen reader is told the page is
// working rather than being told nothing at all.
export function Splash(): JSX.Element {
  return (
    <div className={styles.splash} role="status" aria-live="polite">
      <div className={styles.thread} aria-hidden="true" />
      <Wordmark size={28} />
      <p className={styles.tagline}>{messages.app.tagline}</p>
      <span className="sr-only">{messages.a11y.loadingRegion}</span>
    </div>
  );
}
