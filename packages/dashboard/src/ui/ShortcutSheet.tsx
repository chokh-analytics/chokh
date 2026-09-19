import { useEffect, useRef, type JSX } from 'react';

import { messages } from '../messages/en.js';
import styles from './ShortcutSheet.module.css';

// The card that says what the keys are.
//
// It exists because a shortcut nobody can discover is a shortcut for the person
// who wrote it. "?" is the convention, the sheet lists every binding rather
// than a chosen few, and it closes on Escape and on a click outside like every
// other layer in this product.

export interface ShortcutRow {
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export function ShortcutSheet({
  groups,
  onClose,
}: {
  groups: ShortcutGroup[];
  onClose: () => void;
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus goes into the sheet, so the next Tab is inside it and Escape is
    // read by the dialog rather than by the page behind it.
    panel.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.scrim} onMouseDown={onClose}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={messages.shortcuts.title}
        tabIndex={-1}
        ref={panel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <h2 className={styles.title}>{messages.shortcuts.title}</h2>
          <button type="button" className={styles.close} onClick={onClose}>
            {messages.shortcuts.close}
          </button>
        </header>
        <div className={styles.groups}>
          {groups.map((group) => (
            <section key={group.title}>
              <h3 className={styles.groupTitle}>{group.title}</h3>
              <dl className={styles.rows}>
                {group.rows.map((row) => (
                  <div key={row.label} className={styles.row}>
                    <dt className={styles.keys}>
                      {row.keys.map((key) => (
                        <kbd key={key} className={styles.key}>
                          {key}
                        </kbd>
                      ))}
                    </dt>
                    <dd className={styles.label}>{row.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className={styles.note}>{messages.shortcuts.note}</p>
      </div>
    </div>
  );
}
