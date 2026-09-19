import type { JSX, ReactNode } from 'react';

import { RangeBar } from '../app/RangeBar.js';
import styles from './ReportPage.module.css';

// The frame every report after the Overview sits in.
//
// One range bar, one hidden title, then cards. The title is hidden because the
// navigation already says which report this is and a heading repeating it is a
// line of chrome above the numbers; leaving it out of the markup as well is a
// different thing, because then a screen reader lands on a page with no name
// and a heading order audit fails.

export function ReportPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.page}>
      <h1 className="sr-only">{title}</h1>
      <RangeBar />
      <div className={styles.stack}>{children}</div>
    </div>
  );
}

// Two cards side by side on a wide screen, stacked on a narrow one. Used where
// two dimensions are the same question asked twice, like a browser and the
// system under it.
export function ReportRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.row}>{children}</div>;
}
