import type { JSX, ReactNode } from 'react';
import { Link } from 'wouter';

import styles from './Card.module.css';

export interface CardTab {
  id: string;
  label: string;
}

export interface CardProps {
  title: string;
  // The right hand side of the head: usually the name of the metric the numbers
  // in this card are, so a column of figures never needs a header row of its own.
  metric?: string;
  tabs?: CardTab[];
  tab?: string;
  onTab?: (id: string) => void;
  help?: ReactNode;
  footer?: { to: string; label: string };
  children: ReactNode;
}

export function Card({
  title,
  metric,
  tabs,
  tab,
  onTab,
  help,
  footer,
  children,
}: CardProps): JSX.Element {
  return (
    <section className={styles.card} aria-label={title}>
      <header className={styles.head}>
        <h2 className={styles.title}>
          {title}
          {help}
        </h2>
        {tabs !== undefined && tabs.length > 0 ? (
          <div className={styles.tabs} role="tablist" aria-label={title}>
            {tabs.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === tab}
                className={[styles.tab, candidate.id === tab ? styles.tabCurrent : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onTab?.(candidate.id)}
              >
                {candidate.label}
              </button>
            ))}
          </div>
        ) : (
          metric !== undefined && <span className={styles.metric}>{metric}</span>
        )}
      </header>
      <div className={styles.body}>{children}</div>
      {footer !== undefined && (
        <footer className={styles.foot}>
          <Link to={footer.to} className={styles.footLink}>
            {footer.label}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M9 6l6 6-6 6z" />
            </svg>
          </Link>
        </footer>
      )}
    </section>
  );
}
