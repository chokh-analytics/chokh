import { useEffect, useId, useRef, type JSX } from 'react';

import styles from './Team.module.css';

// Something the Team page is asking, or showing once: the keys question, the
// roles still standing, the link. It takes the focus when it appears, so a
// keyboard and a screen reader land on the question that has just been asked
// and not three cards above it.
export function Panel({
  title,
  children,
}: {
  title: string;
  children: JSX.Element | (JSX.Element | false)[];
}): JSX.Element {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} className={styles.panel} role="group" aria-labelledby={id} tabIndex={-1}>
      <h3 className={styles.panelTitle} id={id}>
        {title}
      </h3>
      {children}
    </div>
  );
}
