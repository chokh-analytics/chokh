import { useId, useState, type JSX } from 'react';

import styles from './InfoDot.module.css';

// The sentence that says what a number actually means.
//
// The most important one in this product explains that visitors over several
// days is the sum of each day, so somebody who came on three days counts three
// times. A dashboard that does not say that is quietly lying about its headline
// figure, and every analytics product that reports daily uniques has the same
// problem and mostly stays quiet about it.
//
// It opens on hover and on focus, so a keyboard reaches it, and it is a button
// rather than a title attribute because a title is unreadable on a touch screen
// and unreachable without a mouse.
export function InfoDot({ text, label }: { text: string; label: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={styles.dot}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2Zm0-8h-2V7h2Z" />
        </svg>
      </button>
      {open && (
        <span className={styles.bubble} id={id} role="tooltip">
          {text}
        </span>
      )}
    </span>
  );
}
