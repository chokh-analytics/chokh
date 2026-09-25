import type { JSX } from 'react';

import { saveJson } from '../lib/download.js';
import { format, messages } from '../messages/en.js';
import styles from './Download.module.css';

// The one download control every report card carries (AN-RPT01): CSV as a
// plain link to the server's file, JSON as what the page holds. Both named
// for the reader of a screen: "Download CSV", "Download JSON", under a group
// named for the card, so two cards on one page are two groups and not one.

export interface DownloadProps {
  // The server's file, with the query on screen.
  csvHref: string;
  // What the page holds; undefined while it is on its way.
  json: () => unknown;
  // The file's name without its extension, the same one the server uses.
  name: string;
  // The card, for the group's name.
  title: string;
}

export function Download({ csvHref, json, name, title }: DownloadProps): JSX.Element {
  const held = json();
  return (
    <span
      className={styles.group}
      role="group"
      aria-label={format(messages.reports.downloadGroup, { title })}
    >
      <span className={styles.label}>{messages.reports.downloadLabel}</span>
      <a
        className={styles.item}
        href={csvHref}
        download
        aria-label={messages.reports.downloadCsvName}
        title={messages.reports.downloadNote}
      >
        {messages.reports.downloadCsv}
      </a>
      <button
        type="button"
        className={styles.item}
        aria-label={messages.reports.downloadJsonName}
        title={messages.reports.downloadJsonNote}
        disabled={held === undefined}
        onClick={() => {
          if (held !== undefined) {
            saveJson(name, held);
          }
        }}
      >
        {messages.reports.downloadJson}
      </button>
    </span>
  );
}
