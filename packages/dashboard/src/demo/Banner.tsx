import type { JSX } from 'react';

import { DEMO_SITE } from '../../e2e/demo-site.mjs';
import styles from './Banner.module.css';

// On every page of the demo, above the dashboard: what this is, and what it
// is not. English here and not in the messages file, because this is not a
// string of the product: it exists only in the demo build.
export function DemoBanner({ docs }: { docs: string }): JSX.Element {
  return (
    <aside className={styles.banner} aria-label="About this demo">
      {/* On a phone, the two things a reader must know, in one line; the rest
          from a tablet's width up, where it costs no screen. */}
      <p className={`${styles.text} ${styles.short}`}>
        <strong>Demo: invented data</strong>, and nothing is saved.
      </p>
      <p className={`${styles.text} ${styles.long}`}>
        <strong>A demo with invented data.</strong> {DEMO_SITE.name} is not a real business, and
        nothing you change here is saved. It answers as an install with a licence key: Alerts,
        Digests and more than one team are Chokh Pro.
      </p>
      <a className={styles.link} href={docs}>
        Back to the docs
      </a>
    </aside>
  );
}
