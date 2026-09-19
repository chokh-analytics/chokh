import type { JSX, ReactNode } from 'react';

import { messages } from '../messages/en.js';
import styles from './Breakdown.module.css';

// The row every report in this dashboard is made of.
//
// Clicking one adds its value as a filter and stays where it is, which is the
// fourth of the five rules this product is designed around: click a country and
// the whole page becomes that country, rather than going somewhere else to find
// out how.
//
// A row that cannot be filtered is not a button and has no hover. The store
// refuses a filter naming an entry page, an exit page or a channel, because a
// raw event does not carry them, and a row that looks pressable and does
// nothing is worse than one that does not look pressable at all.

export interface BreakdownRowView {
  key: string;
  // Already formatted, and already the human label: a channel is "Organic
  // search" here and not "organic".
  label: string;
  value: string;
  // The exact number, for a title attribute, when the label above is compact.
  title?: string;
  // A second, quieter column. Used where one number is not the whole answer:
  // pageviews beside visitors, a share beside a count.
  secondary?: string;
  // 0 to 1, against the biggest row in the card.
  share: number;
  icon?: ReactNode;
  unknown?: boolean;
  onClick?: () => void;
}

export interface BreakdownProps {
  rows: BreakdownRowView[];
  dimensionLabel: string;
  valueLabel: string;
  secondaryLabel?: string;
  // Off inside a card, where the card head already says both column names. On
  // in a full report, where a table with three columns needs them.
  showHead?: boolean;
  caption: string;
}

export function Breakdown({
  rows,
  dimensionLabel,
  valueLabel,
  secondaryLabel,
  showHead = false,
  caption,
}: BreakdownProps): JSX.Element {
  return (
    <table className={styles.table}>
      <caption className="sr-only">{caption}</caption>
      {/*
        Always a head, drawn only on a full report.
        //
        A card says its two column names in its own header, so repeating them
        above the rows is a line of chrome. Leaving them out of the markup as
        well is a different thing: a screen reader then reads a column of
        numbers with nothing to call them, on every card of the Overview.
      */}
      <thead className={showHead ? styles.head : 'sr-only'}>
        <tr>
          {/*
            Two headers in the first cell, because the first cell holds two
            things: the row's name on the left and its number on the right,
            with the bar drawn behind both. Three <th> over two <td> is what
            put "Pageviews" over the visitor count and "Visitors" over nothing.
          */}
          <th scope="col">
            <span className={styles.headPair}>
              <span>{dimensionLabel}</span>
              <span>{valueLabel}</span>
            </span>
          </th>
          {secondaryLabel !== undefined && (
            <th scope="col" className={styles.headSecondary}>
              {secondaryLabel}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const content = (
            <>
              <span className={styles.label}>
                {row.icon}
                <span className={row.unknown === true ? styles.unknown : undefined}>
                  {row.unknown === true ? messages.states.unknown : row.label}
                </span>
              </span>
              <span className={styles.value} title={row.title}>
                {row.value}
              </span>
            </>
          );

          return (
            <tr key={row.key} className={styles.row}>
              <td className={styles.cell}>
                <span
                  className={styles.bar}
                  style={{ width: `${Math.max(0, Math.min(1, row.share)) * 100}%` }}
                  aria-hidden="true"
                />
                {row.onClick === undefined ? (
                  <span className={styles.inner}>{content}</span>
                ) : (
                  <button
                    type="button"
                    className={[styles.inner, styles.clickable].join(' ')}
                    onClick={row.onClick}
                  >
                    {content}
                  </button>
                )}
              </td>
              {secondaryLabel !== undefined && (
                <td className={styles.secondary}>{row.secondary ?? ''}</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// A short code beside a long name: a country's ISO letters, a language tag, a
// device kind. Mono and quiet, so it labels the row rather than competing with
// it.
export function Code({ children }: { children: ReactNode }): JSX.Element {
  return <span className={styles.code}>{children}</span>;
}
