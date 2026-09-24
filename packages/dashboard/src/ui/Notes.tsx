import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';
import type { Annotation, AnnotationKind } from '@chokh/store/contract';
import { ANNOTATION_KINDS, MAX_ANNOTATIONS_PER_SITE, MAX_ANNOTATION_TEXT } from '@chokh/store/contract';
import { dayBounds, dayKey } from '@chokh/store/time';

import { canWrite, useApp } from '../app/context.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { api } from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { formatClock, formatDateTime } from '../lib/format.js';
import { annotationsKey, useAnnotations } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Button } from './Button.js';
import { Field, SelectField } from './Field.js';
import popover from './Popover.module.css';
import styles from './Notes.module.css';

// The marks of the range, as a list, and the form that adds one.
//
// Loaded when the panel opens and not before: the marks themselves are drawn
// by the chart from a read the Overview already makes, so the first paint
// pays for the guides and nothing here, and this chunk is what opening the
// panel costs. An owner or an editor adds and deletes; anybody else reads the
// list and one sentence saying who can.

const KIND_OPTIONS = ANNOTATION_KINDS.map((kind) => ({
  value: kind,
  label: messages.annotations.kinds[kind],
}));

function useRefreshAnnotations(): () => Promise<void> {
  const queryClient = useQueryClient();
  const { site } = useApp();
  // The prefix, so every range's list is asked again and not only the one on
  // screen: a mark added while looking at a week is in the month too.
  return () => queryClient.invalidateQueries({ queryKey: annotationsKey(site.id) });
}

function NoteRow({ annotation, writer }: { annotation: Annotation; writer: boolean }): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefreshAnnotations();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const timezone = site.settings.timezone;

  async function remove(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api.deleteAnnotation(client, site.id, annotation.id);
      await refresh();
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
      setBusy(false);
    }
  }

  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.kind}>{messages.annotations.kinds[annotation.kind]}</span>
        <span className={styles.when}>{formatDateTime(annotation.at, timezone)}</span>
      </div>
      <p className={styles.text}>
        {annotation.text}
        {annotation.url !== undefined && (
          <>
            {' '}
            <a className={styles.link} href={annotation.url} target="_blank" rel="noreferrer">
              {messages.annotations.openLink}
            </a>
          </>
        )}
      </p>
      {writer &&
        (confirming ? (
          <div className={styles.actions}>
            <span className={styles.note}>{messages.annotations.deleteConfirm}</span>
            {problem !== null && (
              <span className={styles.note} role="alert">
                {problem}
              </span>
            )}
            <Button onClick={() => void remove()} disabled={busy}>
              {messages.annotations.deleteYes}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
              {messages.annotations.deleteNo}
            </Button>
          </div>
        ) : (
          <div className={styles.actions}>
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              {messages.annotations.delete}
            </Button>
          </div>
        ))}
    </li>
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// A date and a clock time in the site's zone, as one instant. Through
// dayBounds, so the day starts where the site's midnight is and not where
// the reader's is; the minutes are added on top, which is exact everywhere a
// day has 24 hours and one hour out across a daylight-saving change, which is
// accepted rather than solved.
export function instantOf(date: string, time: string, timezone: string): number | null {
  if (!DATE.test(date) || !TIME.test(time)) {
    return null;
  }
  const [hours, minutes] = time.split(':').map(Number);
  return dayBounds(date, timezone).start + (hours ?? 0) * 3_600_000 + (minutes ?? 0) * 60_000;
}

function AddNote({ onSaved }: { onSaved: () => void }): JSX.Element {
  const { client, site, now } = useApp();
  const refresh = useRefreshAnnotations();
  const timezone = site.settings.timezone;
  const [kind, setKind] = useState<AnnotationKind>('note');
  const [date, setDate] = useState(() => dayKey(now, timezone));
  const [time, setTime] = useState(() => formatClock(now, timezone));
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const at = instantOf(date, time, timezone);
  const missingText = tried && text.trim() === '';
  const badWhen = tried && at === null;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    if (text.trim() === '' || at === null) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.createAnnotation(client, site.id, {
        at,
        kind,
        text: text.trim(),
        ...(url.trim() === '' ? {} : { url: url.trim() }),
      });
      setText('');
      setUrl('');
      setTried(false);
      await refresh();
      onSaved();
    } catch (error) {
      setProblem(
        error instanceof ChokhError && error.code === 'ANNOTATION_EXISTS'
          ? messages.annotations.exists
          : error instanceof ChokhError && error.code === 'ANNOTATION_LIMIT'
            ? format(messages.annotations.limit, { max: MAX_ANNOTATIONS_PER_SITE })
            : error instanceof ChokhError
              ? error.message
              : messages.states.error,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <p className={popover.heading}>{messages.annotations.addTitle}</p>
      <SelectField
        label={messages.annotations.kind}
        options={KIND_OPTIONS}
        value={kind}
        disabled={busy}
        onChange={(event) => setKind(event.target.value as AnnotationKind)}
      />
      <div className={styles.when2}>
        <Field
          label={messages.annotations.date}
          type="date"
          value={date}
          disabled={busy}
          onChange={(event) => setDate(event.target.value)}
          {...(badWhen ? { problem: messages.annotations.badWhen } : {})}
        />
        <Field
          label={format(messages.annotations.time, { zone: timezone })}
          type="time"
          value={time}
          disabled={busy}
          onChange={(event) => setTime(event.target.value)}
        />
      </div>
      <Field
        label={messages.annotations.text}
        placeholder={messages.annotations.textPlaceholder}
        maxLength={MAX_ANNOTATION_TEXT}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        {...(missingText ? { problem: messages.annotations.required } : {})}
      />
      <Field
        label={messages.annotations.link}
        placeholder={messages.annotations.linkPlaceholder}
        type="url"
        value={url}
        disabled={busy}
        onChange={(event) => setUrl(event.target.value)}
      />
      {problem !== null && (
        <p className={styles.note} role="alert">
          {problem}
        </p>
      )}
      <Button type="submit" variant="primary" block disabled={busy}>
        {busy ? messages.annotations.saving : messages.annotations.save}
      </Button>
    </form>
  );
}

export interface NotesPanelProps {
  close: () => void;
}

export default function NotesPanel({ close }: NotesPanelProps): JSX.Element {
  const { client, site, me, now } = useApp();
  const { query } = useViewQuery();
  const notes = useAnnotations({ client, siteId: site.id, query, now });
  const list = notes.data?.data.annotations ?? [];
  const writer = canWrite(me.teams, site.teamId);

  return (
    <div className={styles.panel}>
      <p className={popover.heading}>{messages.annotations.picker}</p>
      {notes.isError ? (
        <p className={styles.note}>{messages.states.error}</p>
      ) : notes.isPending ? null : list.length === 0 ? (
        <>
          <p className={styles.note}>{messages.annotations.empty}</p>
          <p className={styles.note}>{messages.annotations.emptyLede}</p>
        </>
      ) : (
        <ul className={styles.list}>
          {list.map((annotation) => (
            <NoteRow key={annotation.id} annotation={annotation} writer={writer} />
          ))}
        </ul>
      )}
      <div className={popover.divider} />
      {writer ? <AddNote onSaved={close} /> : <p className={styles.note}>{messages.annotations.writerOnly}</p>}
    </div>
  );
}
