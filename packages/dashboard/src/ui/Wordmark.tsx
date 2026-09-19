import type { JSX } from 'react';

import { messages } from '../messages/en.js';
import styles from './Wordmark.module.css';

// The mark, drawn rather than set.
//
// Chokh means eye. It is inline SVG so it needs no image request, no icon font
// and no second colour: it takes the accent from the theme it is in, which is
// the whole reason it is not a PNG.

export function Wordmark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <span className={styles.wordmark}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        className={styles.eye}
      >
        <path
          d="M2 12c3-4.4 6.3-6.6 10-6.6S19 7.6 22 12c-3 4.4-6.3 6.6-10 6.6S5 16.4 2 12Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      </svg>
      <span className={styles.name}>{messages.app.name}</span>
    </span>
  );
}
